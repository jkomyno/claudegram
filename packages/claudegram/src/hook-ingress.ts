import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createConnection, createServer } from 'node:net'
import type { Server, Socket } from 'node:net'

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

import {
  HOOK_PROTOCOL_VERSION,
  type HookAcknowledgement,
  type HookEnvelope,
  type HookRejection,
  type HookResponse,
  encodeHookEnvelope,
  encodeHookResponse,
  parseHookEnvelope,
  parseHookResponse,
} from './protocol'
import { isMissingFile } from './node-errors'
import { SessionRegistry } from './session-registry'
import { socketIsAlive } from './unix-socket'

const MAX_HOOK_MESSAGE_BYTES = 1024 * 1024

export class HookIngressError extends Data.TaggedError('HookIngressError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface RunningHookIngress {
  readonly socketPath: string
  readonly close: Effect.Effect<void, HookIngressError>
}

export interface HookIngressOptions {
  readonly onEnvelope?: (
    envelope: HookEnvelope,
  ) => Effect.Effect<void, unknown>
}

const encodeResponse = (response: HookResponse): string =>
  `${encodeHookResponse(response)}\n`

const rejection = (message: string): HookRejection => ({
  type: 'error',
  version: HOOK_PROTOCOL_VERSION,
  accepted: false,
  message,
})

const acknowledgement = (sessionId: string): HookAcknowledgement => ({
  type: 'ack',
  version: HOOK_PROTOCOL_VERSION,
  accepted: true,
  sessionId,
})

const prepareSocketPath = async (socketPath: string): Promise<void> => {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })

  try {
    const existing = await lstat(socketPath)
    if (!existing.isSocket()) {
      throw new HookIngressError({
        message: `refusing to replace non-socket path: ${socketPath}`,
      })
    }

    if (await socketIsAlive(socketPath)) {
      throw new HookIngressError({
        message: `another claudegram daemon is listening at ${socketPath}`,
      })
    }

    await unlink(socketPath)
  } catch (cause) {
    if (
      cause instanceof HookIngressError ||
      !isMissingFile(cause)
    ) {
      throw cause
    }
  }
}

const closeServer = async (
  server: Server,
  socketPath: string,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve()
      } else {
        reject(cause)
      }
    })
  })

  try {
    const existing = await lstat(socketPath)
    if (existing.isSocket()) {
      await unlink(socketPath)
    }
  } catch (cause) {
    if (!isMissingFile(cause)) {
      throw cause
    }
  }
}

const listen = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off('listening', onListening)
      reject(cause)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })

const handleConnection = (
  socket: Socket,
  record: (envelope: HookEnvelope) => Effect.Effect<unknown>,
  onEnvelope?: HookIngressOptions['onEnvelope'],
): void => {
  let buffer = ''
  let handled = false

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    if (handled) {
      return
    }

    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_HOOK_MESSAGE_BYTES) {
      handled = true
      socket.end(encodeResponse(rejection('hook request exceeds 1 MiB')))
      return
    }

    const newline = buffer.indexOf('\n')
    if (newline < 0) {
      return
    }

    handled = true
    const line = buffer.slice(0, newline)

    try {
      const envelope = parseHookEnvelope(line)
      const handle =
        onEnvelope === undefined
          ? record(envelope)
          : record(envelope).pipe(Effect.andThen(onEnvelope(envelope)))
      Effect.runPromise(handle).then(
        () => socket.end(encodeResponse(acknowledgement(envelope.event.session_id))),
        () => socket.end(encodeResponse(rejection('failed to record hook event'))),
      )
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'invalid hook request'
      socket.end(encodeResponse(rejection(message)))
    }
  })
}

export const startHookIngress = (
  socketPath: string,
  options: HookIngressOptions = {},
): Effect.Effect<RunningHookIngress, HookIngressError, SessionRegistry> =>
  Effect.gen(function* () {
    const registry = yield* SessionRegistry

    return yield* Effect.tryPromise({
      try: async () => {
        await prepareSocketPath(socketPath)
        const server = createServer((socket) =>
          handleConnection(socket, registry.record, options.onEnvelope),
        )

        await listen(server, socketPath)
        await chmod(socketPath, 0o600)

        return {
          socketPath,
          close: Effect.tryPromise({
            try: () => closeServer(server, socketPath),
            catch: (cause) =>
              new HookIngressError({
                message: `failed to close hook ingress at ${socketPath}`,
                cause,
              }),
          }),
        }
      },
      catch: (cause) =>
        cause instanceof HookIngressError
          ? cause
          : new HookIngressError({
              message: `failed to listen at ${socketPath}`,
              cause,
            }),
    })
  })

export const sendHookEnvelope = (
  socketPath: string,
  envelope: HookEnvelope,
): Effect.Effect<HookAcknowledgement, HookIngressError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<HookAcknowledgement>((resolve, reject) => {
        const socket = createConnection({ path: socketPath })
        let buffer = ''

        socket.setEncoding('utf8')
        socket.once('connect', () => {
          socket.write(`${encodeHookEnvelope(envelope)}\n`)
        })
        socket.on('data', (chunk: string) => {
          buffer += chunk
          const newline = buffer.indexOf('\n')
          if (newline < 0) {
            return
          }

          try {
            const response = parseHookResponse(buffer.slice(0, newline))
            socket.destroy()
            if (response.type === 'error') {
              reject(new Error(response.message))
            } else {
              resolve(response)
            }
          } catch (cause) {
            socket.destroy()
            reject(cause)
          }
        })
        socket.once('error', reject)
        socket.once('end', () => {
          if (buffer.indexOf('\n') < 0) {
            reject(new Error('hook ingress closed without a response'))
          }
        })
      }),
    catch: (cause) =>
      new HookIngressError({
        message: `failed to send hook event to ${socketPath}`,
        cause,
      }),
  })

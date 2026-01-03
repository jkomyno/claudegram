import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeHookEnvelope,
  makeSessionRegistry,
  parseHookEvent,
  probeHookIngress,
  sendHookEnvelope,
  SessionRegistry,
  startHookIngress,
} from '../../src'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('hook ingress contract', () => {
  it('round-trips every installed hook event through the unix socket', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'claudegram-test-'))
    temporaryDirectories.push(temporaryDirectory)
    const socketPath = join(temporaryDirectory, 'daemon.sock')
    const fixtureNames = [
      'session-start',
      'notification',
      'pre-tool-use',
      'permission-request',
      'post-tool-use',
      'post-tool-use-failure',
      'pre-compact',
      'stop',
      'subagent-stop',
    ] as const
    const registry = await Effect.runPromise(makeSessionRegistry)
    const registryLayer = Layer.succeed(SessionRegistry, registry)
    const ingress = await Effect.runPromise(
      startHookIngress(socketPath).pipe(Effect.provide(registryLayer)),
    )

    try {
      for (const fixtureName of fixtureNames) {
        const fixturePath = fileURLToPath(
          new URL(
            `../fixtures/hook-events/${fixtureName}.json`,
            import.meta.url,
          ),
        )
        const event = parseHookEvent(
          JSON.parse(await readFile(fixturePath, 'utf8')),
        )
        const acknowledgement = await Effect.runPromise(
          sendHookEnvelope(
            socketPath,
            makeHookEnvelope(
              event,
              { host: 'contract-host', tmuxPane: '%42' },
              new Date('2026-08-13T10:00:00.000Z'),
            ),
          ),
        )

        expect(acknowledgement.sessionId).toBe(event.session_id)

        const session = Option.getOrThrow(
          await Effect.runPromise(registry.get(event.session_id)),
        )
        expect(session).toMatchObject({
          id: event.session_id,
          host: 'contract-host',
          tmuxPane: '%42',
          cwd: '/tmp/claudegram-contract',
          lastActivityAt: '2026-08-13T10:00:00.000Z',
          lastEvent: {
            hook_event_name: event.hook_event_name,
          },
        })
      }
    } finally {
      await Effect.runPromise(ingress.close)
    }
  })

  it('bounds identity probes when another socket accepts without replying', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'claudegram-test-'))
    temporaryDirectories.push(temporaryDirectory)
    const socketPath = join(temporaryDirectory, 'held.sock')
    const sockets = new Set<import('node:net').Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    try {
      await expect(
        Effect.runPromise(probeHookIngress(socketPath, 'token', 25)),
      ).rejects.toThrow('failed to verify daemon')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((cause) =>
          cause === undefined ? resolve() : reject(cause),
        )
      })
    }
  })
})

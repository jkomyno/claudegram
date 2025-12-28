import { spawn } from 'node:child_process'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { createConnection } from 'node:net'

import type * as HttpClient from '@effect/platform/HttpClient'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

import { Config, type ClaudegramConfig } from './config'
import { startHookIngress } from './hook-ingress'
import { makeNotifier, Notifier } from './notifier'
import { makeSessionRegistry, SessionRegistry } from './session-registry'
import { makeTelegramApi, TelegramApi } from './telegram-api'
import { runTelegramPolling } from './telegram-polling'
import { handleTelegramUpdate } from './telegram-update-handler'
import { makeTmuxBridge, TmuxBridge } from './tmux-bridge'
import { makeToolMuteRules, ToolMuteRules } from './tool-mute-rules'
import { makeTopicManager, TopicManager } from './topic-manager'

export interface DaemonPaths {
  readonly stateDirectory: string
  readonly pidPath: string
  readonly logPath: string
}

export type DaemonState =
  | { readonly status: 'stopped'; readonly pid?: number }
  | { readonly status: 'starting'; readonly pid: number }
  | { readonly status: 'degraded'; readonly pid: number }
  | { readonly status: 'running'; readonly pid: number }

export class DaemonError extends Data.TaggedError('DaemonError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const daemonPaths = (config: ClaudegramConfig): DaemonPaths => {
  const stateDirectory = dirname(config.socketPath)
  return {
    stateDirectory,
    pidPath: join(stateDirectory, 'daemon.pid'),
    logPath: join(stateDirectory, 'daemon.log'),
  }
}

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === 'ENOENT'

const readPid = async (pidPath: string): Promise<number | undefined> => {
  try {
    const pid = Number((await readFile(pidPath, 'utf8')).trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch (cause) {
    if (isMissingFile(cause)) {
      return undefined
    }
    throw cause
  }
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 'EPERM'
    )
  }
}

export const socketIsAlive = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ path: socketPath })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })

export const inspectDaemon = (
  config: ClaudegramConfig,
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.tryPromise({
    try: async () => {
      const pid = await readPid(daemonPaths(config).pidPath)
      if (pid === undefined) {
        return { status: 'stopped' } as const
      }
      if (!pidIsAlive(pid)) {
        return { status: 'stopped', pid } as const
      }

      return (await socketIsAlive(config.socketPath))
        ? ({ status: 'running', pid } as const)
        : ({ status: 'degraded', pid } as const)
    },
    catch: (cause) =>
      new DaemonError({ message: 'failed to inspect daemon state', cause }),
  })

const waitForState = async (
  config: ClaudegramConfig,
  expected: 'running' | 'stopped',
  timeoutMilliseconds = 5000,
): Promise<DaemonState> => {
  const deadline = Date.now() + timeoutMilliseconds
  let last = await Effect.runPromise(inspectDaemon(config))

  while (last.status !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    last = await Effect.runPromise(inspectDaemon(config))
  }

  return last
}

const launchCommand = (): {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
} => {
  const script = process.argv[1]
  if (
    script !== undefined &&
    ['.js', '.mjs', '.cjs', '.ts'].includes(extname(script))
  ) {
    return { executable: process.execPath, arguments: [script, 'daemon'] }
  }

  return { executable: process.execPath, arguments: ['daemon'] }
}

export const startDaemon = (
  config: ClaudegramConfig,
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.tryPromise({
    try: async () => {
      if (config.botToken === undefined || config.chatId === undefined) {
        throw new DaemonError({
          message: 'bot token and Telegram chat id are required before starting',
        })
      }

      const current = await Effect.runPromise(inspectDaemon(config))
      if (current.status === 'running' || current.status === 'degraded') {
        return current
      }

      const paths = daemonPaths(config)
      await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 })
      const output = await open(paths.logPath, 'a', 0o600)
      const command = launchCommand()
      const child = spawn(command.executable, command.arguments, {
        detached: true,
        env: process.env,
        stdio: ['ignore', output.fd, output.fd],
      })
      child.unref()
      await output.close()

      const state = await waitForState(config, 'running')
      if (state.status !== 'running') {
        throw new DaemonError({
          message: `daemon did not become ready; inspect ${paths.logPath}`,
        })
      }
      return state
    },
    catch: (cause) =>
      cause instanceof DaemonError
        ? cause
        : new DaemonError({ message: 'failed to start daemon', cause }),
  })

export const stopDaemon = (
  config: ClaudegramConfig,
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.tryPromise({
    try: async () => {
      const paths = daemonPaths(config)
      const pid = await readPid(paths.pidPath)
      if (pid === undefined || !pidIsAlive(pid)) {
        await unlink(paths.pidPath).catch((cause) => {
          if (!isMissingFile(cause)) throw cause
        })
        return { status: 'stopped', ...(pid === undefined ? {} : { pid }) } as const
      }

      process.kill(pid, 'SIGTERM')
      const state = await waitForState(config, 'stopped')
      if (state.status !== 'stopped') {
        throw new DaemonError({ message: `daemon ${pid} did not stop within 5 seconds` })
      }
      return state
    },
    catch: (cause) =>
      cause instanceof DaemonError
        ? cause
        : new DaemonError({ message: 'failed to stop daemon', cause }),
  })

export const restartDaemon = (
  config: ClaudegramConfig,
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.gen(function* () {
    yield* stopDaemon(config)
    return yield* startDaemon(config)
  })

const waitForSignal = (): Effect.Effect<NodeJS.Signals> =>
  Effect.async((resume) => {
    const finish = (signal: NodeJS.Signals) => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
      resume(Effect.succeed(signal))
    }
    const onInterrupt = () => finish('SIGINT')
    const onTerminate = () => finish('SIGTERM')
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)

    return Effect.sync(() => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
    })
  })

export const runDaemon = (
  config: ClaudegramConfig,
): Effect.Effect<void, DaemonError, HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (config.botToken === undefined || config.chatId === undefined) {
        return yield* new DaemonError({
          message: 'bot token and Telegram chat id are required',
        })
      }

      const paths = daemonPaths(config)
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 })
            const existing = await readPid(paths.pidPath)
            if (existing !== undefined && existing !== process.pid && pidIsAlive(existing)) {
              throw new DaemonError({ message: `daemon ${existing} is already running` })
            }
            await writeFile(paths.pidPath, `${process.pid}\n`, { mode: 0o600 })
          },
          catch: (cause) =>
            cause instanceof DaemonError
              ? cause
              : new DaemonError({ message: 'failed to acquire daemon pid file', cause }),
        }),
        () =>
          Effect.promise(() =>
            unlink(paths.pidPath).catch((cause) => {
              if (!isMissingFile(cause)) throw cause
            }),
          ),
      )

      const api = yield* makeTelegramApi({ botToken: config.botToken })
      const registry = yield* makeSessionRegistry
      const topics = yield* makeTopicManager.pipe(
        Effect.provideService(Config, config),
        Effect.provideService(TelegramApi, api),
        Effect.provideService(SessionRegistry, registry),
      )
      const tmux = makeTmuxBridge()
      const muteRules = makeToolMuteRules()
      const notifier = yield* makeNotifier.pipe(
        Effect.provideService(Config, config),
        Effect.provideService(TelegramApi, api),
        Effect.provideService(SessionRegistry, registry),
        Effect.provideService(TopicManager, topics),
        Effect.provideService(ToolMuteRules, muteRules),
      )
      const ingress = yield* startHookIngress(config.socketPath, {
        onEnvelope: (envelope) => notifier.notify(envelope).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(SessionRegistry, registry))
      yield* Effect.addFinalizer(() => ingress.close.pipe(Effect.ignore))

      const provideRuntimeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(Config, config),
          Effect.provideService(Notifier, notifier),
          Effect.provideService(SessionRegistry, registry),
          Effect.provideService(TelegramApi, api),
          Effect.provideService(TmuxBridge, tmux),
          Effect.provideService(TopicManager, topics),
        )

      yield* Effect.forkScoped(
        runTelegramPolling((update) =>
          provideRuntimeServices(handleTelegramUpdate(update)),
        ).pipe(Effect.provideService(TelegramApi, api)),
      )
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep('5 minutes').pipe(
            Effect.andThen(
              topics.cleanupInactiveBefore(
                new Date(Date.now() - config.topicTtlHours * 60 * 60 * 1000),
              ),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        ),
      )

      yield* waitForSignal()
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof DaemonError
        ? cause
        : new DaemonError({ message: 'daemon stopped after an error', cause }),
    ),
  )

export const readDaemonLogs = (
  config: ClaudegramConfig,
  lines = 100,
): Effect.Effect<string, DaemonError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const content = await readFile(daemonPaths(config).logPath, 'utf8')
        return content.split('\n').slice(-Math.max(lines, 1) - 1).join('\n')
      } catch (cause) {
        if (isMissingFile(cause)) return ''
        throw cause
      }
    },
    catch: (cause) =>
      new DaemonError({ message: 'failed to read daemon logs', cause }),
  })

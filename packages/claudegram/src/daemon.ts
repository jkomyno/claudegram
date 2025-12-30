import { spawn } from 'node:child_process'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import type * as HttpClient from '@effect/platform/HttpClient'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'

import { Config, type ClaudegramConfig } from './config'
import { loadDaemonSnapshot, writeDaemonSnapshot } from './daemon-state'
import { startHookIngress } from './hook-ingress'
import { isMissingFile } from './node-errors'
import { makeNotifier, Notifier } from './notifier'
import {
  makeSessionRegistryWithSessions,
  SessionRegistry,
} from './session-registry'
import { makeTelegramApi, TelegramApi } from './telegram-api'
import { runTelegramPolling } from './telegram-polling'
import { handleTelegramUpdate } from './telegram-update-handler'
import {
  controlInstalledService,
  type ServiceInstallOptions,
} from './service-install'
import { makeTmuxBridge, TmuxBridge } from './tmux-bridge'
import { makeToolMuteRules, ToolMuteRules } from './tool-mute-rules'
import {
  makeTopicManagerWithOptions,
  TopicManager,
} from './topic-manager'
import { socketIsAlive } from './unix-socket'

export { socketIsAlive } from './unix-socket'

export interface DaemonPaths {
  readonly stateDirectory: string
  readonly pidPath: string
  readonly logPath: string
  readonly snapshotPath: string
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

export interface DaemonControlOptions {
  readonly service?: ServiceInstallOptions
}

export const daemonPaths = (config: ClaudegramConfig): DaemonPaths => {
  const stateDirectory = dirname(config.socketPath)
  return {
    stateDirectory,
    pidPath: join(stateDirectory, 'daemon.pid'),
    logPath: join(stateDirectory, 'daemon.log'),
    snapshotPath: join(stateDirectory, 'daemon-state.json'),
  }
}

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
  options: DaemonControlOptions = {},
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.tryPromise({
    try: async () => {
      if (config.botToken === undefined || config.chatId === undefined) {
        throw new DaemonError({
          message: 'bot token and Telegram chat id are required before starting',
        })
      }

      const current = await Effect.runPromise(inspectDaemon(config))
      if (current.status === 'running') {
        return current
      }

      const paths = daemonPaths(config)
      const managed = await Effect.runPromise(
        controlInstalledService('start', options.service),
      )
      if (managed) {
        const state = await waitForState(config, 'running')
        if (state.status !== 'running') {
          throw new DaemonError({
            message: `managed daemon did not become ready; inspect ${paths.logPath}`,
          })
        }
        return state
      }

      if (current.status === 'degraded') {
        await unlink(paths.pidPath).catch((cause) => {
          if (!isMissingFile(cause)) throw cause
        })
      }
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
  options: DaemonControlOptions = {},
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.tryPromise({
    try: async () => {
      const paths = daemonPaths(config)
      const managed = await Effect.runPromise(
        controlInstalledService('stop', options.service),
      )
      if (managed) {
        const state = await waitForState(config, 'stopped')
        if (state.status !== 'stopped') {
          throw new DaemonError({
            message: 'managed daemon did not stop within 5 seconds',
          })
        }
        return state
      }

      const current = await Effect.runPromise(inspectDaemon(config))
      if (current.status === 'stopped' || current.status === 'degraded') {
        await unlink(paths.pidPath).catch((cause) => {
          if (!isMissingFile(cause)) throw cause
        })
        return {
          status: 'stopped',
          ...('pid' in current ? { pid: current.pid } : {}),
        } as const
      }

      process.kill(current.pid, 'SIGTERM')
      const state = await waitForState(config, 'stopped')
      if (state.status !== 'stopped') {
        throw new DaemonError({
          message: `daemon ${current.pid} did not stop within 5 seconds`,
        })
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
  options: DaemonControlOptions = {},
): Effect.Effect<DaemonState, DaemonError> =>
  controlInstalledService('restart', options.service).pipe(
    Effect.mapError(
      (cause) => new DaemonError({ message: 'failed to restart daemon', cause }),
    ),
    Effect.flatMap((managed) =>
      managed
        ? Effect.tryPromise({
            try: async () => {
              const state = await waitForState(config, 'running')
              if (state.status !== 'running') {
                throw new DaemonError({
                  message: 'managed daemon did not restart within 5 seconds',
                })
              }
              return state
            },
            catch: (cause) =>
              cause instanceof DaemonError
                ? cause
                : new DaemonError({ message: 'failed to restart daemon', cause }),
          })
        : stopDaemon(config, options).pipe(
            Effect.andThen(startDaemon(config, options)),
          ),
    ),
  )

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

export const cleanupInactiveTopics = (
  topics: Pick<TopicManager['Service'], 'cleanupInactiveBefore'>,
  topicTtlHours: number,
  now: () => number = Date.now,
) =>
  Effect.suspend(() =>
    topics.cleanupInactiveBefore(
      new Date(now() - topicTtlHours * 60 * 60 * 1000),
    ),
  )

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

      const snapshot = yield* loadDaemonSnapshot(paths.snapshotPath)
      const api = yield* makeTelegramApi({ botToken: config.botToken })
      const registry = yield* makeSessionRegistryWithSessions(snapshot.sessions)
      const sessionIds = new Set(snapshot.sessions.map((session) => session.id))
      const topics = yield* makeTopicManagerWithOptions({
        initialTopics: snapshot.topics.filter((topic) =>
          sessionIds.has(topic.sessionId),
        ),
      }).pipe(
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
      const persistence = yield* Effect.makeSemaphore(1)
      const persistState = persistence.withPermits(1)(
        Effect.all({
          sessions: registry.list,
          topics: topics.list,
        }).pipe(
          Effect.flatMap((current) =>
            writeDaemonSnapshot(paths.snapshotPath, current),
          ),
        ),
      )
      const ingress = yield* startHookIngress(config.socketPath, {
        onEnvelope: (envelope) =>
          notifier.notify(envelope).pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
                persistState.pipe(Effect.andThen(Effect.fail(cause))),
              onSuccess: () => persistState,
            }),
          ),
      }).pipe(Effect.provideService(SessionRegistry, registry))
      yield* Effect.addFinalizer(() => ingress.close.pipe(Effect.ignore))
      yield* Effect.addFinalizer(() => persistState.pipe(Effect.ignore))

      const provideRuntimeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(Config, config),
          Effect.provideService(Notifier, notifier),
          Effect.provideService(SessionRegistry, registry),
          Effect.provideService(TelegramApi, api),
          Effect.provideService(TmuxBridge, tmux),
          Effect.provideService(TopicManager, topics),
        )

      const pollingFiber = yield* Effect.forkScoped(
        runTelegramPolling((update) =>
          provideRuntimeServices(handleTelegramUpdate(update)),
        ).pipe(Effect.provideService(TelegramApi, api)),
      )
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep('5 minutes').pipe(
            Effect.andThen(
              cleanupInactiveTopics(topics, config.topicTtlHours),
            ),
            Effect.matchEffect({
              onFailure: () => persistState,
              onSuccess: () => persistState,
            }),
            Effect.catchAll(() => Effect.void),
          ),
        ),
      )

      yield* Effect.raceFirst(waitForSignal(), Fiber.join(pollingFiber))
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

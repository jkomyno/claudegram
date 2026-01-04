import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import type * as HttpClient from '@effect/platform/HttpClient'
import * as Data from 'effect/Data'
import type * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'

import { Config, type ClaudegramConfig } from './config'
import {
  type DaemonSnapshot,
  loadDaemonSnapshot,
  writeDaemonSnapshot,
} from './daemon-state'
import { probeHookIngress, startHookIngress } from './hook-ingress'
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
import {
  makeTmuxBridge,
  TmuxBridge,
  type TmuxBridgeService,
} from './tmux-bridge'
import { makeToolMuteRules, ToolMuteRules } from './tool-mute-rules'
import {
  makeTopicManagerWithOptions,
  TopicManager,
  type TopicManagerService,
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
  readonly launchDaemon?: (command: DaemonLaunchCommand) => Promise<void>
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void
  readonly waitForState?: (
    config: ClaudegramConfig,
    expected: 'running' | 'stopped',
  ) => Promise<DaemonState>
}

export interface DaemonLaunchCommand {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly logPath: string
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

interface DaemonIdentity {
  readonly pid: number
  readonly token?: string
}

const ProcessIdSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.filter(Number.isSafeInteger, {
    description: 'a safe positive process id',
  }),
)

const DaemonIdentityJsonSchema = Schema.parseJson(
  Schema.Struct({
    pid: ProcessIdSchema,
    token: Schema.NonEmptyString,
  }),
)
const LegacyPidSchema = Schema.NumberFromString.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.filter(Number.isSafeInteger, {
    description: 'a safe positive process id',
  }),
)

const readDaemonIdentity = async (
  pidPath: string,
): Promise<DaemonIdentity | undefined> => {
  try {
    const content = (await readFile(pidPath, 'utf8')).trim()
    const current = Schema.decodeUnknownOption(DaemonIdentityJsonSchema)(content)
    if (Option.isSome(current)) return current.value

    const legacy = Schema.decodeUnknownOption(LegacyPidSchema)(content)
    return Option.isSome(legacy) ? { pid: legacy.value } : undefined
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

const inspectDaemonWithIdentity = async (
  config: ClaudegramConfig,
): Promise<{
  readonly state: DaemonState
  readonly identity?: DaemonIdentity
}> => {
  const identity = await readDaemonIdentity(daemonPaths(config).pidPath)
  if (identity === undefined) return { state: { status: 'stopped' } }
  if (!pidIsAlive(identity.pid)) {
    return { state: { status: 'stopped', pid: identity.pid }, identity }
  }
  if (identity.token === undefined) {
    return { state: { status: 'degraded', pid: identity.pid }, identity }
  }

  const verified = await Effect.runPromise(
    probeHookIngress(config.socketPath, identity.token).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  )
  return {
    state: verified
      ? { status: 'running', pid: identity.pid }
      : { status: 'degraded', pid: identity.pid },
    identity,
  }
}

export const inspectDaemon = (
  config: ClaudegramConfig,
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.tryPromise({
    try: async () => (await inspectDaemonWithIdentity(config)).state,
    catch: (cause) =>
      new DaemonError({ message: 'failed to inspect daemon state', cause }),
  })

const waitForState = async (
  config: ClaudegramConfig,
  expected: 'running' | 'stopped',
  timeoutMilliseconds = 10_000,
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

const launchDetachedDaemon = async (
  command: DaemonLaunchCommand,
): Promise<void> => {
  const output = await open(command.logPath, 'a', 0o600)
  try {
    const child = spawn(command.executable, command.arguments, {
      detached: true,
      env: process.env,
      stdio: ['ignore', output.fd, output.fd],
    })
    child.unref()
  } finally {
    await output.close()
  }
}

const removeIdentityIfMatches = async (
  pidPath: string,
  expected: DaemonIdentity | undefined,
): Promise<void> => {
  if (expected === undefined) return
  const current = await readDaemonIdentity(pidPath)
  if (
    current?.pid !== expected.pid ||
    current.token !== expected.token
  ) {
    return
  }
  await unlink(pidPath).catch((cause) => {
    if (!isMissingFile(cause)) throw cause
  })
}

const isExistingFile = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === 'EEXIST'

const acquireDaemonIdentity = async (
  pidPath: string,
  identity: DaemonIdentity & { readonly token: string },
): Promise<void> => {
  const encoded = Schema.encodeSync(DaemonIdentityJsonSchema)(identity)
  const recoveryPath = `${pidPath}.recovery`
  const temporaryPath = `${pidPath}.${identity.token}.tmp`
  await writeFile(temporaryPath, `${encoded}\n`, { flag: 'wx', mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await link(temporaryPath, pidPath)
        return
      } catch (cause) {
        if (!isExistingFile(cause)) throw cause

        const existing = await readDaemonIdentity(pidPath)
        if (existing !== undefined && pidIsAlive(existing.pid)) {
          throw new DaemonError({
            message: `daemon ${existing.pid} is already starting or running`,
          })
        }

        try {
          await link(temporaryPath, recoveryPath)
        } catch (recoveryCause) {
          if (!isExistingFile(recoveryCause)) throw recoveryCause
          const recoveryOwner = await readDaemonIdentity(recoveryPath)
          if (recoveryOwner !== undefined && !pidIsAlive(recoveryOwner.pid)) {
            await removeIdentityIfMatches(recoveryPath, recoveryOwner)
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
          continue
        }

        try {
          const current = await readDaemonIdentity(pidPath)
          if (current !== undefined && pidIsAlive(current.pid)) {
            throw new DaemonError({
              message: `daemon ${current.pid} is already starting or running`,
            })
          }
          await rename(temporaryPath, pidPath)
          return
        } finally {
          await removeIdentityIfMatches(recoveryPath, identity)
        }
      }
    }

    throw new DaemonError({
      message: `failed to acquire daemon pid file ${pidPath}`,
    })
  } finally {
    await unlink(temporaryPath).catch((cause) => {
      if (!isMissingFile(cause)) throw cause
    })
  }
}

export const startDaemon = (
  config: ClaudegramConfig,
  options: DaemonControlOptions = {},
): Effect.Effect<DaemonState, DaemonError> =>
  Effect.tryPromise({
    try: async () => {
      if (
        config.botToken === undefined ||
        config.chatId === undefined ||
        config.ownerUserId === undefined
      ) {
        throw new DaemonError({
          message:
            'bot token, Telegram chat id, and owner user id are required before starting',
        })
      }

      const inspected = await inspectDaemonWithIdentity(config)
      const current = inspected.state
      if (current.status === 'running') {
        return current
      }

      const paths = daemonPaths(config)
      const wait = options.waitForState ?? waitForState
      if (
        current.status === 'degraded' &&
        inspected.identity?.token !== undefined
      ) {
        const recovered = await wait(config, 'running')
        if (recovered.status === 'running') return recovered
        throw new DaemonError({
          message: `daemon ${current.pid} is still starting or unavailable; its identity was preserved`,
        })
      }
      const managed = await Effect.runPromise(
        controlInstalledService('start', options.service),
      )
      if (managed) {
        const state = await wait(config, 'running')
        if (state.status !== 'running') {
          throw new DaemonError({
            message: `managed daemon did not become ready; inspect ${paths.logPath}`,
          })
        }
        return state
      }

      if (current.status === 'degraded') {
        await removeIdentityIfMatches(paths.pidPath, inspected.identity)
      }
      await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 })
      const command = launchCommand()
      await (options.launchDaemon ?? launchDetachedDaemon)({
        ...command,
        logPath: paths.logPath,
      })

      const state = await wait(config, 'running')
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
      const inspected = await inspectDaemonWithIdentity(config)
      const identity = inspected.identity
      const wait = options.waitForState ?? waitForState
      const managed = await Effect.runPromise(
        controlInstalledService('stop', options.service),
      )
      if (managed) {
        const state = await wait(config, 'stopped')
        if (state.status !== 'stopped') {
          throw new DaemonError({
            message: 'managed daemon did not stop within 10 seconds',
          })
        }
        await removeIdentityIfMatches(paths.pidPath, identity)
        return state
      }

      let current = inspected.state
      if (
        current.status === 'degraded' &&
        identity?.token !== undefined
      ) {
        const recovered = await wait(config, 'running')
        if (recovered.status !== 'running') {
          throw new DaemonError({
            message: `daemon ${current.pid} is still starting or unavailable; its identity was preserved`,
          })
        }
        current = recovered
      }

      if (current.status === 'stopped' || current.status === 'degraded') {
        await removeIdentityIfMatches(paths.pidPath, identity)
        return {
          status: 'stopped',
          ...('pid' in current ? { pid: current.pid } : {}),
        } as const
      }

      const signalProcess = options.signalProcess ?? process.kill
      signalProcess(current.pid, 'SIGTERM')
      const state = await wait(config, 'stopped')
      if (state.status !== 'stopped') {
        throw new DaemonError({
          message: `daemon ${current.pid} did not stop within 10 seconds`,
        })
      }
      await removeIdentityIfMatches(paths.pidPath, identity)
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
              const state = await (options.waitForState ?? waitForState)(
                config,
                'running',
              )
              if (state.status !== 'running') {
                throw new DaemonError({
                  message: 'managed daemon did not restart within 10 seconds',
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
  topics: Pick<TopicManagerService, 'cleanupInactiveBefore'>,
  topicTtlHours: number,
  now: () => number = Date.now,
) =>
  Effect.suspend(() =>
    topics.cleanupInactiveBefore(
      new Date(now() - topicTtlHours * 60 * 60 * 1000),
    ),
  )

export const restoreDaemonSnapshot = (
  snapshot: DaemonSnapshot,
  tmux: Pick<TmuxBridgeService, 'hasPane'>,
  options: {
    readonly concurrency?: number
    readonly timeout?: Duration.DurationInput
  } = {},
): Effect.Effect<DaemonSnapshot> =>
  Effect.gen(function* () {
    const availableIds = yield* Ref.make<ReadonlySet<string>>(new Set())
    yield* Effect.forEach(
      snapshot.sessions,
      (session) =>
        tmux.hasPane(session).pipe(
          Effect.flatMap((available) =>
            available
              ? Ref.update(availableIds, (ids) =>
                  new Set(ids).add(session.id),
                )
              : Effect.void,
          ),
        ),
      { concurrency: options.concurrency ?? 8 },
    ).pipe(
      Effect.timeoutTo({
        duration: options.timeout ?? '5 seconds',
        onSuccess: () => undefined,
        onTimeout: () => undefined,
      }),
    )

    const retainedIds = yield* Ref.get(availableIds)
    return {
      sessions: snapshot.sessions.filter((session) =>
        retainedIds.has(session.id),
      ),
      topics: snapshot.topics.filter((topic) =>
        retainedIds.has(topic.sessionId),
      ),
    }
  })

export const runDaemon = (
  config: ClaudegramConfig,
): Effect.Effect<void, DaemonError, HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (
        config.botToken === undefined ||
        config.chatId === undefined ||
        config.ownerUserId === undefined
      ) {
        return yield* new DaemonError({
          message:
            'bot token, Telegram chat id, and owner user id are required',
        })
      }

      const paths = daemonPaths(config)
      const identityToken = randomUUID()
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 })
            await acquireDaemonIdentity(paths.pidPath, {
              pid: process.pid,
              token: identityToken,
            })
          },
          catch: (cause) =>
            cause instanceof DaemonError
              ? cause
              : new DaemonError({ message: 'failed to acquire daemon pid file', cause }),
        }),
        () =>
          Effect.promise(async () => {
            await removeIdentityIfMatches(paths.pidPath, {
              pid: process.pid,
              token: identityToken,
            })
          }),
      )

      const configuredTmuxExecutable =
        process.env.CLAUDEGRAM_TMUX_EXECUTABLE
      const tmux = makeTmuxBridge(
        configuredTmuxExecutable === undefined
          ? {}
          : { executable: configuredTmuxExecutable },
      )
      const snapshot = yield* loadDaemonSnapshot(paths.snapshotPath).pipe(
        Effect.flatMap((loaded) => restoreDaemonSnapshot(loaded, tmux)),
      )
      const api = yield* makeTelegramApi({ botToken: config.botToken })
      const registry = yield* makeSessionRegistryWithSessions(snapshot.sessions)
      const topics = yield* makeTopicManagerWithOptions({
        initialTopics: snapshot.topics,
      }).pipe(
        Effect.provideService(Config, config),
        Effect.provideService(TelegramApi, api),
        Effect.provideService(SessionRegistry, registry),
      )
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
        identityToken,
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
        const safeContent =
          config.botToken === undefined
            ? content
            : content.replaceAll(config.botToken, '[REDACTED]')
        return safeContent
          .split('\n')
          .slice(-Math.max(lines, 1) - 1)
          .join('\n')
      } catch (cause) {
        if (isMissingFile(cause)) return ''
        throw cause
      }
    },
    catch: (cause) =>
      new DaemonError({ message: 'failed to read daemon logs', cause }),
  })

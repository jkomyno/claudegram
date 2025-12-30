import { execFile } from 'node:child_process'

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { Session } from './session-registry'

export interface TmuxBridgeService {
  readonly sendText: (
    session: Session,
    text: string,
  ) => Effect.Effect<void, TmuxBridgeError>
  readonly interrupt: (
    session: Session,
  ) => Effect.Effect<void, TmuxBridgeError>
}

export class TmuxBridge extends Context.Tag('@claudegram/TmuxBridge')<
  TmuxBridge,
  TmuxBridgeService
>() {}

export class TmuxBridgeError extends Data.TaggedError('TmuxBridgeError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface TmuxBridgeOptions {
  readonly executable?: string
  readonly socketName?: string
  readonly commandTimeoutMilliseconds?: number
}

const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 5_000

const paneFor = (
  session: Session,
): Effect.Effect<string, TmuxBridgeError> => {
  if (session.tmuxPane === undefined || session.tmuxPane.length === 0) {
    return Effect.fail(
      new TmuxBridgeError({
        message: `session ${session.id} is not attached to a tmux pane`,
      }),
    )
  }

  return Effect.succeed(session.tmuxPane)
}

export const makeTmuxBridge = (
  options: TmuxBridgeOptions = {},
): TmuxBridgeService => {
  const executable = options.executable ?? 'tmux'
  const prefix =
    options.socketName === undefined ? [] : ['-L', options.socketName]
  const commandTimeoutMilliseconds =
    options.commandTimeoutMilliseconds ?? DEFAULT_COMMAND_TIMEOUT_MILLISECONDS

  const run = (args: ReadonlyArray<string>, message: string) =>
    Effect.tryPromise({
      try: (signal) =>
        new Promise<void>((resolve, reject) => {
          execFile(
            executable,
            [...prefix, ...args],
            {
              killSignal: 'SIGKILL',
              signal,
              timeout: commandTimeoutMilliseconds,
            },
            (cause) => {
              if (cause === null) {
                resolve()
              } else {
                reject(cause)
              }
            }
          )
        }),
      catch: (cause) => new TmuxBridgeError({ message, cause }),
    })

  return TmuxBridge.of({
    sendText: (session, text) =>
      Effect.gen(function* () {
        const pane = yield* paneFor(session)
        yield* run(
          ['send-keys', '-t', pane, '-l', '--', text],
          `failed to send text to tmux pane ${pane}`,
        )
        yield* run(
          ['send-keys', '-t', pane, 'Enter'],
          `failed to submit text in tmux pane ${pane}`,
        )
      }),
    interrupt: (session) =>
      Effect.gen(function* () {
        const pane = yield* paneFor(session)
        yield* run(
          ['send-keys', '-t', pane, 'C-c'],
          `failed to interrupt tmux pane ${pane}`,
        )
      }),
  })
}

export const TmuxBridgeLive = Layer.succeed(TmuxBridge, makeTmuxBridge())

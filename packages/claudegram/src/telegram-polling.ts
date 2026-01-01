import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import * as Schedule from 'effect/Schedule'

import { TelegramApi, type TelegramUpdate } from './telegram-api'

export class TelegramPollingError extends Data.TaggedError(
  'TelegramPollingError',
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type TelegramUpdateHandler = (
  update: TelegramUpdate,
) => Effect.Effect<void, unknown>

export interface TelegramPollingOptions {
  readonly initialRetryDelay?: Duration.DurationInput
  readonly maximumRetryDelay?: Duration.DurationInput
}

const DEFAULT_INITIAL_RETRY_DELAY = Duration.seconds(1)
const DEFAULT_MAXIMUM_RETRY_DELAY = Duration.seconds(30)

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export const pollTelegramOnce = (
  offset: number | undefined,
  handler: TelegramUpdateHandler,
): Effect.Effect<number | undefined, TelegramPollingError, TelegramApi> =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    const updates = yield* api.getUpdates({ offset, timeout: 30 })
    let nextOffset = offset

    for (const update of updates) {
      yield* handler(update).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning('Skipping failed Telegram update').pipe(
            Effect.annotateLogs({
              telegramUpdateId: update.update_id,
              failure: failureMessage(cause),
            }),
          ),
        ),
      )
      nextOffset = update.update_id + 1
    }

    return nextOffset
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TelegramPollingError({
          message: 'Telegram update polling failed',
          cause,
        }),
    ),
  )

export const runTelegramPolling = (
  handler: TelegramUpdateHandler,
  options: TelegramPollingOptions = {},
): Effect.Effect<never, TelegramPollingError, TelegramApi> =>
  Effect.gen(function* () {
    const offset = yield* Ref.make<number | undefined>(undefined)
    const maximumRetryDelay =
      options.maximumRetryDelay ?? DEFAULT_MAXIMUM_RETRY_DELAY
    const retryPolicy = Schedule.exponential(
      options.initialRetryDelay ?? DEFAULT_INITIAL_RETRY_DELAY,
    ).pipe(
      Schedule.modifyDelay((_attempt, delay) =>
        Duration.min(delay, maximumRetryDelay),
      ),
    )

    yield* Effect.forever(
      Effect.gen(function* () {
        const current = yield* Ref.get(offset)
        const next = yield* pollTelegramOnce(current, handler).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning('Telegram polling failed; retrying', cause),
          ),
          Effect.retry(retryPolicy),
        )
        yield* Ref.set(offset, next)
      }),
    )

    return yield* Effect.never
  })

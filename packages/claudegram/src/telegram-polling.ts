import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'

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

export const pollTelegramOnce = (
  offset: number | undefined,
  handler: TelegramUpdateHandler,
): Effect.Effect<number | undefined, TelegramPollingError, TelegramApi> =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    const updates = yield* api.getUpdates({ offset, timeout: 30 })
    let nextOffset = offset

    for (const update of updates) {
      yield* handler(update)
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
): Effect.Effect<never, TelegramPollingError, TelegramApi> =>
  Effect.gen(function* () {
    const offset = yield* Ref.make<number | undefined>(undefined)

    yield* Effect.forever(
      Effect.gen(function* () {
        const current = yield* Ref.get(offset)
        const next = yield* pollTelegramOnce(current, handler)
        yield* Ref.set(offset, next)
      }),
    )

    return yield* Effect.never
  })

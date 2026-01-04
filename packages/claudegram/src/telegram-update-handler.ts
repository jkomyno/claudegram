import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { Config } from './config'
import { Notifier, type PendingTelegramAction } from './notifier'
import { SessionRegistry, type Session } from './session-registry'
import { TelegramApi, type TelegramUpdate } from './telegram-api'
import { TmuxBridge } from './tmux-bridge'
import { TopicManager } from './topic-manager'

export class TelegramUpdateError extends Data.TaggedError(
  'TelegramUpdateError',
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const mapUpdateError = (message: string) => (cause: unknown) =>
  cause instanceof TelegramUpdateError
    ? cause
    : new TelegramUpdateError({ message, cause })

const sessionForThread = (
  threadId: number,
): Effect.Effect<
  Option.Option<Session>,
  never,
  SessionRegistry | TopicManager
> =>
  Effect.gen(function* () {
    const topics = yield* TopicManager
    const registry = yield* SessionRegistry
    const topic = yield* topics.getByThreadId(threadId)
    if (Option.isNone(topic)) {
      return Option.none()
    }

    return yield* registry.get(topic.value.sessionId)
  })

const applyAction = (
  session: Session,
  action: PendingTelegramAction,
): Effect.Effect<void, unknown, TmuxBridge> =>
  Effect.gen(function* () {
    const tmux = yield* TmuxBridge
    switch (action.type) {
      case 'next-question':
      case 'await-reply': {
        return
      }
      case 'abort': {
        yield* tmux.interrupt(session)
        return
      }
      case 'reply': {
        yield* tmux.sendText(session, action.text)
        return
      }
      case 'permission': {
        yield* tmux.sendText(session, action.decision === 'allow' ? 'y' : 'n')
      }
    }
  })

const callbackAnswer = (action: PendingTelegramAction): string => {
  switch (action.type) {
    case 'next-question':
      return 'Answer saved.'
    case 'await-reply':
      return 'Type your reply in the chat.'
    case 'abort':
      return 'Session interrupted.'
    case 'permission':
    case 'reply':
      return 'Sent to Claude.'
  }
}

export const handleTelegramUpdate = (
  update: TelegramUpdate,
): Effect.Effect<
  void,
  TelegramUpdateError,
  | Config
  | Notifier
  | SessionRegistry
  | TelegramApi
  | TmuxBridge
  | TopicManager
> =>
  Effect.gen(function* () {
    const config = yield* Config
    const api = yield* TelegramApi
    const notifier = yield* Notifier
    const tmux = yield* TmuxBridge

    if (update.message !== undefined) {
      const message = update.message
      if (
        config.chatId === undefined ||
        config.ownerUserId === undefined ||
        message.from?.id !== config.ownerUserId ||
        message.chat.id !== config.chatId ||
        message.message_thread_id === undefined ||
        message.text === undefined ||
        message.text.trim().length === 0
      ) {
        return
      }

      const session = yield* sessionForThread(message.message_thread_id)
      if (Option.isNone(session)) {
        return
      }

      if (message.text.trim().toLowerCase() === 'stop') {
        yield* tmux.interrupt(session.value)
      } else {
        yield* tmux.sendText(session.value, message.text)
      }
      return
    }

    const callback = update.callback_query
    if (
      callback === undefined ||
      callback.data === undefined ||
      callback.message?.message_thread_id === undefined ||
      config.chatId === undefined ||
      callback.message.chat.id !== config.chatId
    ) {
      return
    }

    if (
      config.ownerUserId === undefined ||
      callback.from.id !== config.ownerUserId
    ) {
      yield* api.answerCallbackQuery(callback.id, 'Not authorized.')
      return
    }

    const session = yield* sessionForThread(
      callback.message.message_thread_id,
    )
    if (Option.isNone(session)) {
      yield* api.answerCallbackQuery(callback.id, 'This action has expired.')
      return
    }

    const action = yield* notifier.resolveCallback(
      callback.data,
      session.value.id,
    )
    if (
      Option.isNone(action) ||
      action.value.sessionId !== session.value.id
    ) {
      yield* api.answerCallbackQuery(callback.id, 'This action has expired.')
      return
    }

    yield* applyAction(session.value, action.value).pipe(
      Effect.tapError(() =>
        notifier.retryCallback(callback.data ?? '', action.value),
      ),
    )
    yield* api.answerCallbackQuery(callback.id, callbackAnswer(action.value))
  }).pipe(
    Effect.mapError(mapUpdateError(`failed to handle Telegram update ${update.update_id}`)),
  )

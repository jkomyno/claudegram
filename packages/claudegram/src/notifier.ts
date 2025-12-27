import { createHash } from 'node:crypto'

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'

import { Config } from './config'
import type { HookEnvelope, HookEvent } from './protocol'
import { SessionRegistry } from './session-registry'
import {
  type InlineKeyboardMarkup,
  TelegramApi,
} from './telegram-api'
import { ToolMuteRules } from './tool-mute-rules'
import { TopicManager } from './topic-manager'

const NotificationEventSchema = Schema.Struct({
  message: Schema.NonEmptyString,
})

const AssistantEventSchema = Schema.Struct({
  last_assistant_message: Schema.NonEmptyString,
})

const ToolEventSchema = Schema.Struct({
  tool_name: Schema.NonEmptyString,
  tool_use_id: Schema.optional(Schema.String),
  tool_input: Schema.optional(Schema.Unknown),
})

const QuestionOptionSchema = Schema.Struct({
  label: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
})

const AskUserQuestionEventSchema = Schema.Struct({
  tool_name: Schema.Literal('AskUserQuestion'),
  tool_input: Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({
        question: Schema.NonEmptyString,
        options: Schema.Array(QuestionOptionSchema),
      }),
    ),
  }),
})

export type PendingTelegramAction =
  | {
      readonly type: 'permission'
      readonly sessionId: string
      readonly toolUseId?: string
      readonly decision: 'allow' | 'deny'
    }
  | {
      readonly type: 'reply'
      readonly sessionId: string
      readonly text: string
    }

export interface NotifyResult {
  readonly sent: boolean
  readonly reason:
    | 'sent'
    | 'muted'
    | 'not-useful'
    | 'topic-created'
  readonly threadId: number
}

export interface NotifierService {
  readonly notify: (
    envelope: HookEnvelope,
  ) => Effect.Effect<NotifyResult, NotifierError>
  readonly resolveCallback: (
    callbackData: string,
  ) => Effect.Effect<Option.Option<PendingTelegramAction>>
}

export class Notifier extends Context.Tag('@claudegram/Notifier')<
  Notifier,
  NotifierService
>() {}

export class NotifierError extends Data.TaggedError('NotifierError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface OutboundNotification {
  readonly text: string
  readonly replyMarkup?: InlineKeyboardMarkup
}

const truncate = (value: string, maximum: number): string => {
  const characters = Array.from(value)
  return characters.length <= maximum
    ? value
    : `${characters.slice(0, maximum - 1).join('')}…`
}

const inputField = (input: unknown, field: string): string | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined
  }

  const value = (input as Readonly<Record<string, unknown>>)[field]
  return typeof value === 'string' ? value : undefined
}

const summarizeTool = (event: typeof ToolEventSchema.Type): string => {
  const detail =
    inputField(event.tool_input, 'command') ??
    inputField(event.tool_input, 'file_path') ??
    inputField(event.tool_input, 'pattern') ??
    inputField(event.tool_input, 'query') ??
    inputField(event.tool_input, 'description')

  return detail === undefined
    ? event.tool_name
    : `${event.tool_name}: ${truncate(detail, 320)}`
}

const callbackToken = (action: PendingTelegramAction): string => {
  const kind = action.type === 'permission' ? 'p' : 'r'
  const digest = createHash('sha256')
    .update(JSON.stringify(action))
    .digest('base64url')
    .slice(0, 18)
  return `cgm:${kind}:${digest}`
}

const mapNotifierError = (message: string) => (cause: unknown) =>
  cause instanceof NotifierError
    ? cause
    : new NotifierError({ message, cause })

const decodeOption = <A, I>(
  schema: Schema.Schema<A, I>,
  event: HookEvent,
): Option.Option<A> => Schema.decodeUnknownOption(schema)(event)

export const makeNotifier = Effect.gen(function* () {
  const config = yield* Config
  const api = yield* TelegramApi
  const registry = yield* SessionRegistry
  const topics = yield* TopicManager
  const muteRules = yield* ToolMuteRules
  const pendingActions = yield* Ref.make<
    ReadonlyMap<string, PendingTelegramAction>
  >(new Map())

  if (config.chatId === undefined) {
    return yield* new NotifierError({
      message: 'Telegram chat id is required to send notifications',
    })
  }

  const chatId = config.chatId

  const registerActions = (
    actions: ReadonlyArray<PendingTelegramAction>,
  ): Effect.Effect<ReadonlyArray<string>> => {
    const entries = actions.map((action) => [callbackToken(action), action] as const)
    return Ref.update(pendingActions, (current) => {
      const next = new Map(current)
      for (const [token, action] of entries) {
        next.set(token, action)
      }
      return next
    }).pipe(Effect.as(entries.map(([token]) => token)))
  }

  const permissionNotification = (
    event: HookEvent,
    sessionId: string,
  ): Effect.Effect<Option.Option<OutboundNotification>> =>
    Effect.gen(function* () {
      const question = decodeOption(AskUserQuestionEventSchema, event)
      if (Option.isSome(question)) {
        const first = question.value.tool_input.questions[0]
        if (first === undefined || first.options.length === 0) {
          return Option.none()
        }

        const actions = first.options.map(
          (option): PendingTelegramAction => ({
            type: 'reply',
            sessionId,
            text: option.label,
          }),
        )
        const tokens = yield* registerActions(actions)
        return Option.some({
          text: `❓ ${first.question}`,
          replyMarkup: {
            inline_keyboard: first.options.map((option, index) => [
              {
                text: truncate(option.label, 40),
                callback_data: tokens[index] ?? '',
              },
            ]),
          },
        })
      }

      const tool = decodeOption(ToolEventSchema, event)
      if (Option.isNone(tool)) {
        return Option.none()
      }

      const actions: ReadonlyArray<PendingTelegramAction> = [
        {
          type: 'permission',
          sessionId,
          ...(tool.value.tool_use_id === undefined
            ? {}
            : { toolUseId: tool.value.tool_use_id }),
          decision: 'allow',
        },
        {
          type: 'permission',
          sessionId,
          ...(tool.value.tool_use_id === undefined
            ? {}
            : { toolUseId: tool.value.tool_use_id }),
          decision: 'deny',
        },
      ]
      const [allowToken = '', denyToken = ''] = yield* registerActions(actions)

      return Option.some({
        text: `🔐 Permission requested\n${summarizeTool(tool.value)}`,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: 'Allow', callback_data: allowToken },
              { text: 'Deny', callback_data: denyToken },
            ],
          ],
        },
      })
    })

  const notificationFor = (
    event: HookEvent,
    sessionId: string,
  ): Effect.Effect<Option.Option<OutboundNotification>> => {
    switch (event.hook_event_name) {
      case 'Notification': {
        return Effect.succeed(
          decodeOption(NotificationEventSchema, event).pipe(
            Option.map(({ message }) => ({ text: `🔔 ${message}` })),
          ),
        )
      }
      case 'Stop':
      case 'SubagentStop': {
        return Effect.succeed(
          decodeOption(AssistantEventSchema, event).pipe(
            Option.map(({ last_assistant_message }) => ({
              text: `Claude\n${truncate(last_assistant_message, 4000)}`,
            })),
          ),
        )
      }
      case 'PreCompact': {
        return Effect.succeed(
          Option.some({ text: '🧹 Claude is compacting this session.' }),
        )
      }
      case 'PermissionRequest': {
        return permissionNotification(event, sessionId)
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const tool = decodeOption(ToolEventSchema, event)
        return Option.isNone(tool)
          ? Effect.succeed(Option.none())
          : Effect.succeed(
              Option.some({
                text: `${
                  event.hook_event_name === 'PostToolUseFailure' ? '⚠️' : '🛠️'
                } ${summarizeTool(tool.value)}`,
              }),
            )
      }
      default: {
        return Effect.succeed(Option.none())
      }
    }
  }

  return Notifier.of({
    notify: (envelope) =>
      Effect.gen(function* () {
        const session = yield* registry.record(envelope)
        const topic = yield* topics.ensure(session)

        if (envelope.event.hook_event_name === 'SessionStart') {
          return {
            sent: false,
            reason: 'topic-created',
            threadId: topic.threadId,
          } as const
        }

        if (
          (envelope.event.hook_event_name === 'PostToolUse' ||
            envelope.event.hook_event_name === 'PostToolUseFailure') &&
          (yield* muteRules.isMuted(envelope.event))
        ) {
          return {
            sent: false,
            reason: 'muted',
            threadId: topic.threadId,
          } as const
        }

        const notification = yield* notificationFor(
          envelope.event,
          session.id,
        )
        if (Option.isNone(notification)) {
          return {
            sent: false,
            reason: 'not-useful',
            threadId: topic.threadId,
          } as const
        }

        yield* api.sendMessage({
          chatId,
          messageThreadId: topic.threadId,
          text: notification.value.text,
          ...(notification.value.replyMarkup === undefined
            ? {}
            : { replyMarkup: notification.value.replyMarkup }),
        })

        return {
          sent: true,
          reason: 'sent',
          threadId: topic.threadId,
        } as const
      }).pipe(
        Effect.mapError(mapNotifierError('failed to deliver hook notification')),
      ),
    resolveCallback: (callbackData) =>
      Ref.modify(pendingActions, (current) => {
        const action = current.get(callbackData)
        if (action === undefined) {
          return [Option.none(), current] as const
        }

        const next = new Map(current)
        next.delete(callbackData)
        return [Option.some(action), next] as const
      }),
  })
})

export const NotifierLive = Layer.effect(Notifier, makeNotifier)

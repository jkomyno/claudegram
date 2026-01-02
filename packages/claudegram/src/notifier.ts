import { randomUUID } from 'node:crypto'

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SynchronizedRef from 'effect/SynchronizedRef'

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
  | {
      readonly type: 'next-question'
      readonly sessionId: string
    }
  | {
      readonly type: 'await-reply'
      readonly sessionId: string
    }
  | {
      readonly type: 'abort'
      readonly sessionId: string
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
    sessionId: string,
  ) => Effect.Effect<Option.Option<PendingTelegramAction>, NotifierError>
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

type Question =
  typeof AskUserQuestionEventSchema.Type['tool_input']['questions'][number]

type PendingCallbackAction =
  | Extract<
      PendingTelegramAction,
      { readonly type: 'permission' | 'await-reply' | 'abort' }
    >
  | {
      readonly type: 'question'
      readonly sessionId: string
      readonly threadId: number
      readonly questions: ReadonlyArray<Question>
      readonly answers: ReadonlyArray<string>
      readonly questionIndex: number
      readonly answer: string
    }

interface PendingCallback {
  readonly interactionId: string
  readonly expiresAt: number
  readonly action: PendingCallbackAction
}

interface CallbackResolution {
  readonly action: PendingTelegramAction
}

export interface NotifierOptions {
  readonly now?: () => Date
}

const CALLBACK_TTL_MILLISECONDS = 15 * 60 * 1000

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

const mapNotifierError = (message: string) => (cause: unknown) =>
  cause instanceof NotifierError
    ? cause
    : new NotifierError({ message, cause })

const decodeOption = <A, I>(
  schema: Schema.Schema<A, I>,
  event: HookEvent,
): Option.Option<A> => Schema.decodeUnknownOption(schema)(event)

const questionText = (
  question: Question,
  index: number,
  total: number,
): string =>
  total === 1
    ? `❓ ${question.question}`
    : `❓ ${index + 1}/${total} ${question.question}`

const questionReply = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<string>,
): string =>
  questions.length === 1
    ? (answers[0] ?? '')
    : answers.map((answer, index) => `${index + 1}. ${answer}`).join('; ')

const questionActions = (
  sessionId: string,
  threadId: number,
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<string>,
  questionIndex: number,
): ReadonlyArray<PendingCallbackAction> => {
  const question = questions[questionIndex]
  if (question === undefined) {
    return []
  }

  return [
    ...question.options.map((option) => ({
      type: 'question' as const,
      sessionId,
      threadId,
      questions,
      answers,
      questionIndex,
      answer: option.label,
    })),
    { type: 'await-reply' as const, sessionId },
    { type: 'abort' as const, sessionId },
  ]
}

export const makeNotifierWithOptions = (
  options: NotifierOptions = {},
) => Effect.gen(function* () {
  const config = yield* Config
  const api = yield* TelegramApi
  const registry = yield* SessionRegistry
  const topics = yield* TopicManager
  const muteRules = yield* ToolMuteRules
  const pendingActions =
    yield* SynchronizedRef.make<ReadonlyMap<string, PendingCallback>>(new Map())
  const now = options.now ?? (() => new Date())

  if (config.chatId === undefined) {
    return yield* new NotifierError({
      message: 'Telegram chat id is required to send notifications',
    })
  }

  const chatId = config.chatId

  const issueActions = (
    actions: ReadonlyArray<PendingCallbackAction>,
    issuedAt: Date,
    interactionId = randomUUID(),
  ): {
    readonly entries: ReadonlyArray<readonly [string, PendingCallback]>
    readonly tokens: ReadonlyArray<string>
  } => {
    const kind = actions[0]?.type === 'permission' ? 'p' : 'q'
    const expiresAt = issuedAt.getTime() + CALLBACK_TTL_MILLISECONDS
    const entries = actions.map(
      (action, index) =>
        [
          `cgm:${kind}:${interactionId}:${index}`,
          { interactionId, expiresAt, action },
        ] as const,
    )
    return { entries, tokens: entries.map(([token]) => token) }
  }

  const registerActions = (
    actions: ReadonlyArray<PendingCallbackAction>,
    invalidatePermissionForSession = false,
  ): Effect.Effect<ReadonlyArray<string>> => {
    const issuedAt = now()
    const { entries, tokens } = issueActions(actions, issuedAt)
    return SynchronizedRef.update(pendingActions, (current) => {
      const next = new Map<string, PendingCallback>()
      const sessionId = actions[0]?.sessionId
      const invalidatedInteractionIds = new Set<string>()
      if (invalidatePermissionForSession) {
        for (const pending of current.values()) {
          if (
            pending.action.type === 'permission' &&
            pending.action.sessionId === sessionId
          ) {
            invalidatedInteractionIds.add(pending.interactionId)
          }
        }
      }
      for (const [token, pending] of current) {
        if (pending.expiresAt <= issuedAt.getTime()) {
          continue
        }
        if (invalidatedInteractionIds.has(pending.interactionId)) {
          continue
        }
        next.set(token, pending)
      }
      for (const [token, pending] of entries) {
        next.set(token, pending)
      }
      return next
    }).pipe(Effect.as(tokens))
  }

  const questionNotification = (
    questions: ReadonlyArray<Question>,
    questionIndex: number,
    tokens: ReadonlyArray<string>,
  ): OutboundNotification => {
    const question = questions[questionIndex]
    if (question === undefined) {
      return { text: '' }
    }

    return {
      text: questionText(question, questionIndex, questions.length),
      replyMarkup: {
        inline_keyboard: [
          ...question.options.map((option, index) => [
            {
              text: truncate(option.label, 40),
              callback_data: tokens[index] ?? '',
            },
          ]),
          [
            {
              text: '✍️ Custom reply',
              callback_data: tokens[question.options.length] ?? '',
            },
            {
              text: '🛑 Abort',
              callback_data: tokens[question.options.length + 1] ?? '',
            },
          ],
        ],
      },
    }
  }

  const permissionNotification = (
    event: HookEvent,
    sessionId: string,
    threadId: number,
  ): Effect.Effect<Option.Option<OutboundNotification>> =>
    Effect.gen(function* () {
      const question = decodeOption(AskUserQuestionEventSchema, event)
      if (Option.isSome(question)) {
        const questions = question.value.tool_input.questions
        if (
          questions.length === 0 ||
          questions.some(({ options }) => options.length === 0)
        ) {
          return Option.none()
        }

        const actions = questionActions(
          sessionId,
          threadId,
          questions,
          [],
          0,
        )
        const tokens = yield* registerActions(actions)
        return Option.some(questionNotification(questions, 0, tokens))
      }

      const tool = decodeOption(ToolEventSchema, event)
      if (Option.isNone(tool)) {
        return Option.none()
      }

      const actions: ReadonlyArray<PendingCallbackAction> = [
        ...(['allow', 'deny'] as const).map((decision) => ({
          type: 'permission' as const,
          sessionId,
          ...(tool.value.tool_use_id === undefined
            ? {}
            : { toolUseId: tool.value.tool_use_id }),
          decision,
        })),
        { type: 'abort', sessionId },
      ]
      const [allowToken = '', denyToken = '', abortToken = ''] =
        yield* registerActions(actions, true)

      return Option.some({
        text: `🔐 Permission requested\n${summarizeTool(tool.value)}`,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: '✅ Allow', callback_data: allowToken },
              { text: '❌ Deny', callback_data: denyToken },
            ],
            [{ text: '🛑 Abort', callback_data: abortToken }],
          ],
        },
      })
    })

  const notificationFor = (
    event: HookEvent,
    sessionId: string,
    threadId: number,
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
      case 'PreToolUse':
      case 'PermissionRequest': {
        return permissionNotification(event, sessionId, threadId)
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
          topic.threadId,
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
    resolveCallback: (callbackData, sessionId) =>
      Effect.gen(function* () {
        const resolvedAt = now()
        const nextInteractionId = randomUUID()
        const resolution = yield* SynchronizedRef.modifyEffect(
          pendingActions,
          (current) => {
          const pending = current.get(callbackData)
          if (pending === undefined) {
              return Effect.succeed([Option.none(), current] as const)
          }

          if (pending.action.sessionId !== sessionId) {
              return Effect.succeed([Option.none(), current] as const)
          }

          const next = new Map<string, PendingCallback>()
          for (const [token, candidate] of current) {
            if (
              candidate.expiresAt > resolvedAt.getTime() &&
              candidate.interactionId !== pending.interactionId
            ) {
              next.set(token, candidate)
            }
          }

          if (pending.expiresAt <= resolvedAt.getTime()) {
              return Effect.succeed([Option.none(), next] as const)
          }

          if (pending.action.type !== 'question') {
              return Effect.succeed([
                Option.some<CallbackResolution>({ action: pending.action }),
                next,
              ] as const)
          }

          const answers = [...pending.action.answers, pending.action.answer]
          const nextQuestionIndex = pending.action.questionIndex + 1
          if (nextQuestionIndex >= pending.action.questions.length) {
              return Effect.succeed([
                Option.some<CallbackResolution>({
                  action: {
                    type: 'reply',
                    sessionId,
                    text: questionReply(pending.action.questions, answers),
                  },
                }),
                next,
              ] as const)
          }

          const actions = questionActions(
            sessionId,
            pending.action.threadId,
            pending.action.questions,
            answers,
            nextQuestionIndex,
          )
          const issued = issueActions(
            actions,
            resolvedAt,
            nextInteractionId,
          )
          for (const [token, candidate] of issued.entries) {
            next.set(token, candidate)
          }

            const notification = questionNotification(
              pending.action.questions,
              nextQuestionIndex,
              issued.tokens,
            )
            return api
              .sendMessage({
                chatId,
                messageThreadId: pending.action.threadId,
                text: notification.text,
                ...(notification.replyMarkup === undefined
                  ? {}
                  : { replyMarkup: notification.replyMarkup }),
              })
              .pipe(
                Effect.as([
                  Option.some<CallbackResolution>({
                    action: { type: 'next-question', sessionId },
                  }),
                  next,
                ] as const),
              )
          },
        )

        if (Option.isNone(resolution)) {
          return Option.none()
        }

        return Option.some(resolution.value.action)
      }).pipe(
        Effect.mapError(mapNotifierError('failed to resolve callback action')),
      ),
  })
})

export const makeNotifier = makeNotifierWithOptions()

export const NotifierLive = Layer.effect(Notifier, makeNotifier)

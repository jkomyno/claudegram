import * as HttpClient from '@effect/platform/HttpClient'
import * as HttpClientRequest from '@effect/platform/HttpClientRequest'
import * as HttpClientResponse from '@effect/platform/HttpClientResponse'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

const TelegramChatSchema = Schema.Struct({
  id: Schema.Number,
  type: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  is_forum: Schema.optional(Schema.Boolean),
})

export const InlineKeyboardButtonSchema = Schema.Struct({
  text: Schema.String,
  callback_data: Schema.String,
})

export type InlineKeyboardButton = typeof InlineKeyboardButtonSchema.Type

export const InlineKeyboardMarkupSchema = Schema.Struct({
  inline_keyboard: Schema.Array(Schema.Array(InlineKeyboardButtonSchema)),
})

export type InlineKeyboardMarkup = typeof InlineKeyboardMarkupSchema.Type

export const TelegramMessageSchema = Schema.Struct({
  message_id: Schema.Number,
  message_thread_id: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  chat: TelegramChatSchema,
  reply_markup: Schema.optional(InlineKeyboardMarkupSchema),
})

export type TelegramMessage = typeof TelegramMessageSchema.Type

export const TelegramCallbackQuerySchema = Schema.Struct({
  id: Schema.String,
  data: Schema.optional(Schema.String),
  message: Schema.optional(TelegramMessageSchema),
})

export type TelegramCallbackQuery = typeof TelegramCallbackQuerySchema.Type

export const TelegramUpdateSchema = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(TelegramMessageSchema),
  callback_query: Schema.optional(TelegramCallbackQuerySchema),
})

export type TelegramUpdate = typeof TelegramUpdateSchema.Type

export const ForumTopicSchema = Schema.Struct({
  message_thread_id: Schema.Number,
  name: Schema.String,
})

export type ForumTopic = typeof ForumTopicSchema.Type

export interface GetUpdatesOptions {
  readonly offset?: number
  readonly timeout?: number
}

export interface SendMessageOptions {
  readonly chatId: number
  readonly messageThreadId?: number
  readonly text: string
  readonly replyMarkup?: InlineKeyboardMarkup
  readonly disableNotification?: boolean
}

export interface TelegramApiService {
  readonly getUpdates: (
    options?: GetUpdatesOptions,
  ) => Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramApiError>
  readonly sendMessage: (
    options: SendMessageOptions,
  ) => Effect.Effect<TelegramMessage, TelegramApiError>
  readonly createForumTopic: (
    chatId: number,
    name: string,
  ) => Effect.Effect<ForumTopic, TelegramApiError>
  readonly deleteForumTopic: (
    chatId: number,
    messageThreadId: number,
  ) => Effect.Effect<void, TelegramApiError>
  readonly answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Effect.Effect<void, TelegramApiError>
}

export class TelegramApi extends Context.Tag('@claudegram/TelegramApi')<
  TelegramApi,
  TelegramApiService
>() {}

export class TelegramApiError extends Data.TaggedError('TelegramApiError')<{
  readonly method: string
  readonly message: string
  readonly cause?: unknown
}> {}

const TelegramFailureSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error_code: Schema.optional(Schema.Number),
  description: Schema.optional(Schema.String),
})

const responseSchema = <A, I>(result: Schema.Schema<A, I>) =>
  Schema.Union(
    Schema.Struct({
      ok: Schema.Literal(true),
      result,
    }),
    TelegramFailureSchema,
  )

export interface TelegramApiOptions {
  readonly botToken: string
  readonly baseUrl?: string
}

export const makeTelegramApi = (
  options: TelegramApiOptions,
): Effect.Effect<TelegramApiService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(
      /\/$/,
      '',
    )

    const call = <A, I>(
      method: string,
      body: Readonly<Record<string, unknown>>,
      result: Schema.Schema<A, I>,
    ): Effect.Effect<A, TelegramApiError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `${baseUrl}/bot${options.botToken}/${method}`,
        ).pipe(HttpClientRequest.bodyUnsafeJson(body))
        const response = yield* client.execute(request)
        const decoded = yield* HttpClientResponse.schemaBodyJson(
          responseSchema(result),
        )(response)

        if (!decoded.ok) {
          return yield* new TelegramApiError({
            method,
            message: decoded.description ?? `Telegram returned ${response.status}`,
          })
        }

        return decoded.result
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof TelegramApiError
            ? cause
            : new TelegramApiError({
                method,
                message: `Telegram API call ${method} failed`,
                cause,
              }),
        ),
      )

    return TelegramApi.of({
      getUpdates: (pollOptions = {}) =>
        call(
          'getUpdates',
          {
            ...(pollOptions.offset === undefined
              ? {}
              : { offset: pollOptions.offset }),
            timeout: pollOptions.timeout ?? 30,
            allowed_updates: ['message', 'callback_query'],
          },
          Schema.Array(TelegramUpdateSchema),
        ),
      sendMessage: (messageOptions) =>
        call(
          'sendMessage',
          {
            chat_id: messageOptions.chatId,
            text: messageOptions.text,
            ...(messageOptions.messageThreadId === undefined
              ? {}
              : { message_thread_id: messageOptions.messageThreadId }),
            ...(messageOptions.replyMarkup === undefined
              ? {}
              : { reply_markup: messageOptions.replyMarkup }),
            ...(messageOptions.disableNotification === undefined
              ? {}
              : { disable_notification: messageOptions.disableNotification }),
          },
          TelegramMessageSchema,
        ),
      createForumTopic: (chatId, name) =>
        call('createForumTopic', { chat_id: chatId, name }, ForumTopicSchema),
      deleteForumTopic: (chatId, messageThreadId) =>
        call(
          'deleteForumTopic',
          { chat_id: chatId, message_thread_id: messageThreadId },
          Schema.Literal(true),
        ).pipe(Effect.asVoid),
      answerCallbackQuery: (callbackQueryId, text) =>
        call(
          'answerCallbackQuery',
          {
            callback_query_id: callbackQueryId,
            ...(text === undefined ? {} : { text }),
          },
          Schema.Literal(true),
        ).pipe(Effect.asVoid),
    })
  })

export const telegramApiLayer = (
  options: TelegramApiOptions,
): Layer.Layer<TelegramApi, never, HttpClient.HttpClient> =>
  Layer.effect(TelegramApi, makeTelegramApi(options))

import { basename } from 'node:path'

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import { Config } from './config'
import { type Session, SessionRegistry } from './session-registry'
import { TelegramApi } from './telegram-api'

export const SessionTopicSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  host: Schema.NonEmptyString,
  threadId: Schema.Number,
  name: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
})

export type SessionTopic = typeof SessionTopicSchema.Type

export interface TopicManagerOptions {
  readonly initialTopics?: ReadonlyArray<SessionTopic>
}

export interface TopicManagerService {
  readonly ensure: (
    session: Session,
  ) => Effect.Effect<SessionTopic, TopicManagerError>
  readonly getBySessionId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<SessionTopic>>
  readonly getByThreadId: (
    threadId: number,
  ) => Effect.Effect<Option.Option<SessionTopic>>
  readonly list: Effect.Effect<ReadonlyArray<SessionTopic>>
  readonly cleanupInactiveBefore: (
    cutoff: Date,
  ) => Effect.Effect<ReadonlyArray<SessionTopic>, TopicManagerError>
}

export class TopicManager extends Context.Tag('@claudegram/TopicManager')<
  TopicManager,
  TopicManagerService
>() {}

export class TopicManagerError extends Data.TaggedError('TopicManagerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const topicNameFor = (session: Session): string => {
  const project =
    session.cwd === undefined || basename(session.cwd).length === 0
      ? 'Claude session'
      : basename(session.cwd)
  const name = `${session.host} · ${project}`
  return Array.from(name).slice(0, 128).join('')
}

const mapError = (message: string) => (cause: unknown) =>
  cause instanceof TopicManagerError
    ? cause
    : new TopicManagerError({ message, cause })

export const makeTopicManagerWithOptions = (
  options: TopicManagerOptions = {},
) => Effect.gen(function* () {
  const config = yield* Config
  const api = yield* TelegramApi
  const registry = yield* SessionRegistry

  if (config.chatId === undefined) {
    return yield* new TopicManagerError({
      message: 'Telegram chat id is required to manage topics',
    })
  }

  const chatId = config.chatId
  const topics = yield* SynchronizedRef.make<ReadonlyMap<string, SessionTopic>>(
    new Map(
      (options.initialTopics ?? []).map((topic) => [topic.sessionId, topic]),
    ),
  )

  return TopicManager.of({
    ensure: (session) =>
      SynchronizedRef.modifyEffect(topics, (current) => {
        const existing = current.get(session.id)
        if (existing !== undefined) {
          return Effect.succeed([existing, current] as const)
        }

        const name = topicNameFor(session)
        return api.createForumTopic(chatId, name).pipe(
          Effect.map((created) => {
            const topic: SessionTopic = {
              sessionId: session.id,
              host: session.host,
              threadId: created.message_thread_id,
              name: created.name,
              createdAt: new Date().toISOString(),
            }
            const next = new Map(current)
            next.set(session.id, topic)
            return [topic, next] as const
          }),
          Effect.mapError(mapError(`failed to create topic for ${session.id}`)),
        )
      }),
    getBySessionId: (sessionId) =>
      SynchronizedRef.get(topics).pipe(
        Effect.map((current) => Option.fromNullable(current.get(sessionId))),
      ),
    getByThreadId: (threadId) =>
      SynchronizedRef.get(topics).pipe(
        Effect.map((current) =>
          Option.fromNullable(
            Array.from(current.values()).find(
              (topic) => topic.threadId === threadId,
            ),
          ),
        ),
      ),
    list: SynchronizedRef.get(topics).pipe(
      Effect.map((current) => Array.from(current.values())),
    ),
    cleanupInactiveBefore: (cutoff) =>
      Effect.gen(function* () {
        const sessions = yield* registry.list
        const staleSessionIds = new Set(
          sessions
            .filter((session) => new Date(session.lastActivityAt) < cutoff)
            .map((session) => session.id),
        )

        const current = yield* SynchronizedRef.get(topics)
        const staleTopics = Array.from(current.values()).filter((topic) =>
          staleSessionIds.has(topic.sessionId),
        )
        const outcomes = yield* Effect.forEach(staleTopics, (topic) =>
          api.deleteForumTopic(chatId, topic.threadId).pipe(
            Effect.map(() => ({ topic, deleted: true as const })),
            Effect.catchAll((cause) =>
              Effect.succeed({ topic, deleted: false as const, cause }),
            ),
          ),
        )
        const removed = outcomes
          .filter((outcome) => outcome.deleted)
          .map((outcome) => outcome.topic)

        for (const topic of removed) {
          yield* SynchronizedRef.update(topics, (currentTopics) => {
            const next = new Map(currentTopics)
            next.delete(topic.sessionId)
            return next
          })
          yield* registry.remove(topic.sessionId)
        }

        const failed = outcomes.find((outcome) => !outcome.deleted)
        if (failed !== undefined && !failed.deleted) {
          return yield* new TopicManagerError({
            message: `failed to delete topic for ${failed.topic.sessionId}`,
            cause: failed.cause,
          })
        }

        return removed
      }).pipe(
        Effect.mapError(mapError('failed to clean up inactive topics')),
      ),
  })
})

export const makeTopicManager = makeTopicManagerWithOptions()

export const TopicManagerLive = Layer.effect(TopicManager, makeTopicManager)

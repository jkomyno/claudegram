import { basename } from 'node:path'

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import { Config } from './config'
import { type Session, SessionRegistry } from './session-registry'
import { TelegramApi } from './telegram-api'

export interface SessionTopic {
  readonly sessionId: string
  readonly host: string
  readonly threadId: number
  readonly name: string
  readonly createdAt: string
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

export const makeTopicManager = Effect.gen(function* () {
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
    new Map(),
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

        const removed = yield* SynchronizedRef.modifyEffect(topics, (current) =>
          Effect.gen(function* () {
            const staleTopics = Array.from(current.values()).filter((topic) =>
              staleSessionIds.has(topic.sessionId),
            )
            const next = new Map(current)

            for (const topic of staleTopics) {
              yield* api.deleteForumTopic(chatId, topic.threadId)
              next.delete(topic.sessionId)
            }

            return [staleTopics, next] as const
          }),
        )

        for (const topic of removed) {
          yield* registry.remove(topic.sessionId)
        }

        return removed
      }).pipe(
        Effect.mapError(mapError('failed to clean up inactive topics')),
      ),
  })
})

export const TopicManagerLive = Layer.effect(TopicManager, makeTopicManager)

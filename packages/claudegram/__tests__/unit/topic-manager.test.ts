import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
import * as Fiber from 'effect/Fiber'
import { describe, expect, it } from 'vitest'

import {
  type ClaudegramConfig,
  Config,
  makeHookEnvelope,
  makeSessionRegistry,
  makeTopicManagerWithOptions,
  parseHookEvent,
  SessionRegistry,
  TelegramApi,
} from '../../src'

const config: ClaudegramConfig = {
  botToken: 'fake-token',
  chatId: -100123,
  socketPath: '/tmp/claudegram.sock',
  topicTtlHours: 72,
  verbose: false,
  configPath: '/tmp/claudegram.json',
}

describe('TopicManager', () => {
  it('commits successful deletions even when another topic deletion fails', async () => {
    const registry = await Effect.runPromise(makeSessionRegistry)
    const makeSession = (id: string) =>
      registry.record(
        makeHookEnvelope(
          parseHookEvent({
            session_id: id,
            hook_event_name: 'SessionStart',
          }),
          { host: 'host-1' },
          new Date('2026-08-01T12:00:00.000Z'),
        ),
      )
    const first = await Effect.runPromise(makeSession('session-1'))
    const second = await Effect.runPromise(makeSession('session-2'))
    const topics = [first, second].map((session, index) => ({
      sessionId: session.id,
      host: session.host,
      threadId: 101 + index,
      name: session.id,
      createdAt: '2026-08-01T12:00:01.000Z',
    }))
    const deletedThreadIds: Array<number> = []
    const api = TelegramApi.of({
      getMe: () => Effect.die('not used'),
      getUpdates: () => Effect.die('not used'),
      sendMessage: () => Effect.die('not used'),
      createForumTopic: () => Effect.die('not used'),
      deleteForumTopic: (_chatId, threadId) =>
        threadId === 101
          ? Effect.fail({ _tag: 'TelegramApiError' as const, message: 'failed' })
          : Effect.sync(() => {
              deletedThreadIds.push(threadId)
            }),
      answerCallbackQuery: () => Effect.die('not used'),
    })
    const manager = await Effect.runPromise(
      makeTopicManagerWithOptions({ initialTopics: topics }).pipe(
        Effect.provideService(Config, config),
        Effect.provideService(TelegramApi, api),
        Effect.provideService(SessionRegistry, registry),
      ),
    )

    const result = await Effect.runPromise(
      manager
        .cleanupInactiveBefore(new Date('2026-08-10T00:00:00.000Z'))
        .pipe(Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    expect(deletedThreadIds).toEqual([102])
    expect(await Effect.runPromise(manager.list)).toEqual([topics[0]])
    expect((await Effect.runPromise(registry.list)).map((session) => session.id)).toEqual([
      'session-1',
    ])
  })

  it('recreates a topic when its session becomes active during cleanup', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* makeSessionRegistry
          const envelope = (sentAt: Date) =>
            makeHookEnvelope(
              parseHookEvent({
                session_id: 'session-1',
                hook_event_name: 'SessionStart',
              }),
              { host: 'host-1' },
              sentAt,
            )
          const stale = yield* registry.record(
            envelope(new Date('2026-08-01T12:00:00.000Z')),
          )
          const deletionStarted = yield* Deferred.make<void>()
          const allowDeletion = yield* Deferred.make<void>()
          let creations = 0
          const api = TelegramApi.of({
            getMe: () => Effect.die('not used'),
            getUpdates: () => Effect.die('not used'),
            sendMessage: () => Effect.die('not used'),
            createForumTopic: (_chatId, name) =>
              Effect.sync(() => {
                creations += 1
                return { message_thread_id: 202, name }
              }),
            deleteForumTopic: () =>
              Deferred.succeed(deletionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowDeletion)),
              ),
            answerCallbackQuery: () => Effect.die('not used'),
          })
          const initialTopic = {
            sessionId: stale.id,
            host: stale.host,
            threadId: 101,
            name: stale.id,
            createdAt: '2026-08-01T12:00:01.000Z',
          }
          const manager = yield* makeTopicManagerWithOptions({
            initialTopics: [initialTopic],
          }).pipe(
            Effect.provideService(Config, config),
            Effect.provideService(TelegramApi, api),
            Effect.provideService(SessionRegistry, registry),
          )

          const cleanup = yield* Effect.forkScoped(
            manager.cleanupInactiveBefore(
              new Date('2026-08-10T00:00:00.000Z'),
            ),
          )
          yield* Deferred.await(deletionStarted)
          const refreshed = yield* registry.record(
            envelope(new Date('2026-08-14T12:00:00.000Z')),
          )
          const ensure = yield* Effect.forkScoped(manager.ensure(refreshed))
          yield* Effect.yieldNow()
          const creationsWhileDeleting = creations

          yield* Deferred.succeed(allowDeletion, undefined)
          const removed = yield* Fiber.join(cleanup)
          const recreated = yield* Fiber.join(ensure)

          return {
            creationsWhileDeleting,
            recreated,
            removed,
            sessions: yield* registry.list,
            topics: yield* manager.list,
          }
        }),
      ),
    )

    expect(result.creationsWhileDeleting).toBe(0)
    expect(result.removed.map((topic) => topic.threadId)).toEqual([101])
    expect(result.recreated.threadId).toBe(202)
    expect(result.sessions).toMatchObject([
      { id: 'session-1', lastActivityAt: '2026-08-14T12:00:00.000Z' },
    ])
    expect(result.topics.map((topic) => topic.threadId)).toEqual([202])
  })

  it('restores an interrupted claim without blocking another topic deletion', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* makeSessionRegistry
          const record = (id: string) =>
            registry.record(
              makeHookEnvelope(
                parseHookEvent({
                  session_id: id,
                  hook_event_name: 'SessionStart',
                }),
                { host: 'host-1' },
                new Date('2026-08-01T12:00:00.000Z'),
              ),
            )
          const first = yield* record('session-1')
          const second = yield* record('session-2')
          const firstStarted = yield* Deferred.make<void>()
          const secondDeleted = yield* Deferred.make<void>()
          const api = TelegramApi.of({
            getMe: () => Effect.die('not used'),
            getUpdates: () => Effect.die('not used'),
            sendMessage: () => Effect.die('not used'),
            createForumTopic: () => Effect.die('not used'),
            deleteForumTopic: (_chatId, threadId) =>
              threadId === 101
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  )
                : Deferred.succeed(secondDeleted, undefined),
            answerCallbackQuery: () => Effect.die('not used'),
          })
          const initialTopics = [first, second].map((session, index) => ({
            sessionId: session.id,
            host: session.host,
            threadId: 101 + index,
            name: session.id,
            createdAt: '2026-08-01T12:00:01.000Z',
          }))
          const manager = yield* makeTopicManagerWithOptions({ initialTopics }).pipe(
            Effect.provideService(Config, config),
            Effect.provideService(TelegramApi, api),
            Effect.provideService(SessionRegistry, registry),
          )
          const cleanup = yield* Effect.forkScoped(
            manager.cleanupInactiveBefore(
              new Date('2026-08-10T00:00:00.000Z'),
            ),
          )

          yield* Deferred.await(firstStarted)
          yield* Deferred.await(secondDeleted)
          yield* Fiber.interrupt(cleanup)

          return {
            sessions: yield* registry.list,
            topics: yield* manager.list,
          }
        }),
      ),
    )

    expect(result.sessions.map((session) => session.id)).toEqual(['session-1'])
    expect(result.topics.map((topic) => topic.threadId)).toEqual([101])
  })
})

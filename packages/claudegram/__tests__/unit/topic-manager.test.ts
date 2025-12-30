import * as Effect from 'effect/Effect'
import * as Either from 'effect/Either'
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
})

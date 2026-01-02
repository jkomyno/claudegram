import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'

import {
  type ClaudegramConfig,
  Config,
  handleTelegramUpdate,
  makeHookEnvelope,
  makeSessionRegistry,
  Notifier,
  parseHookEvent,
  SessionRegistry,
  type SessionTopic,
  TelegramApi,
  TmuxBridge,
  TopicManager,
} from '../../src'

describe('handleTelegramUpdate', () => {
  it('routes text, stop, and callbacks only to the mapped session', async () => {
    const config: ClaudegramConfig = {
      botToken: 'fake-token',
      chatId: -100123,
      ownerUserId: 424242,
      socketPath: '/tmp/claudegram.sock',
      topicTtlHours: 72,
      verbose: false,
      configPath: '/tmp/claudegram.json',
    }
    const owner = {
      id: 424242,
      is_bot: false,
      first_name: 'Alberto',
    } as const
    const registry = await Effect.runPromise(makeSessionRegistry)
    const session = await Effect.runPromise(
      registry.record(
        makeHookEnvelope(
          parseHookEvent({
            session_id: 'session-1',
            hook_event_name: 'SessionStart',
            cwd: '/work/project',
          }),
          { host: 'test-host', tmuxPane: '%9' },
          new Date('2026-08-13T12:00:00.000Z'),
        ),
      ),
    )
    const topic: SessionTopic = {
      sessionId: session.id,
      host: session.host,
      threadId: 101,
      name: 'test-host · project',
      createdAt: '2026-08-13T12:00:00.000Z',
    }
    const topics = TopicManager.of({
      ensure: () => Effect.succeed(topic),
      getBySessionId: (sessionId) =>
        Effect.succeed(sessionId === session.id ? Option.some(topic) : Option.none()),
      getByThreadId: (threadId) =>
        Effect.succeed(threadId === topic.threadId ? Option.some(topic) : Option.none()),
      list: Effect.succeed([topic]),
      cleanupInactiveBefore: () => Effect.succeed([]),
    })
    const tmuxCalls: Array<Readonly<Record<string, unknown>>> = []
    const tmux = TmuxBridge.of({
      hasPane: () => Effect.succeed(true),
      sendText: (target, text) =>
        Effect.sync(() => {
          tmuxCalls.push({ type: 'text', sessionId: target.id, text })
        }),
      interrupt: (target) =>
        Effect.sync(() => {
          tmuxCalls.push({ type: 'interrupt', sessionId: target.id })
        }),
    })
    const callbackActions = new Map([
      [
        'cgm:p:allow',
        {
          type: 'permission',
          sessionId: session.id,
          decision: 'allow',
        } as const,
      ],
      [
        'cgm:r:reply',
        { type: 'reply', sessionId: session.id, text: 'Stable' } as const,
      ],
      [
        'cgm:r:custom',
        { type: 'await-reply', sessionId: session.id } as const,
      ],
      [
        'cgm:r:abort',
        { type: 'abort', sessionId: session.id } as const,
      ],
      [
        'cgm:p:wrong-session',
        {
          type: 'permission',
          sessionId: 'session-2',
          decision: 'allow',
        } as const,
      ],
    ])
    const notifier = Notifier.of({
      notify: () =>
        Effect.succeed({
          sent: false,
          reason: 'not-useful',
          threadId: topic.threadId,
        }),
      resolveCallback: (data) =>
        Effect.succeed(Option.fromNullable(callbackActions.get(data))),
    })
    const callbackAnswers: Array<Readonly<Record<string, unknown>>> = []
    const api = TelegramApi.of({
      getMe: () =>
        Effect.succeed({ id: 1, is_bot: true, first_name: 'test-bot' }),
      getUpdates: () => Effect.succeed([]),
      sendMessage: () =>
        Effect.die(new Error('sendMessage is not used by the update handler')),
      createForumTopic: () =>
        Effect.die(new Error('createForumTopic is not used by the update handler')),
      deleteForumTopic: () => Effect.void,
      answerCallbackQuery: (id, text) =>
        Effect.sync(() => {
          callbackAnswers.push({ id, text })
        }),
    })

    const runUpdate = (update: Parameters<typeof handleTelegramUpdate>[0]) =>
      Effect.runPromise(
        handleTelegramUpdate(update).pipe(
          Effect.provideService(Config, config),
          Effect.provideService(SessionRegistry, registry),
          Effect.provideService(TopicManager, topics),
          Effect.provideService(TmuxBridge, tmux),
          Effect.provideService(Notifier, notifier),
          Effect.provideService(TelegramApi, api),
        ),
      )

    await runUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        message_thread_id: 101,
        text: 'continue with the tests',
        from: owner,
        chat: { id: -100123, type: 'supergroup', is_forum: true },
      },
    })
    await runUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        message_thread_id: 101,
        text: ' STOP ',
        from: owner,
        chat: { id: -100123, type: 'supergroup', is_forum: true },
      },
    })
    await runUpdate({
      update_id: 3,
      callback_query: {
        id: 'callback-allow',
        from: owner,
        data: 'cgm:p:allow',
        message: {
          message_id: 3,
          message_thread_id: 101,
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    })
    await runUpdate({
      update_id: 4,
      callback_query: {
        id: 'callback-reply',
        from: owner,
        data: 'cgm:r:reply',
        message: {
          message_id: 4,
          message_thread_id: 101,
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    })
    await runUpdate({
      update_id: 5,
      callback_query: {
        id: 'callback-custom',
        from: owner,
        data: 'cgm:r:custom',
        message: {
          message_id: 5,
          message_thread_id: 101,
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    })
    await runUpdate({
      update_id: 6,
      message: {
        message_id: 6,
        message_thread_id: 101,
        text: 'Use the custom release channel',
        from: owner,
        chat: { id: -100123, type: 'supergroup', is_forum: true },
      },
    })
    await runUpdate({
      update_id: 7,
      callback_query: {
        id: 'callback-abort',
        from: owner,
        data: 'cgm:r:abort',
        message: {
          message_id: 7,
          message_thread_id: 101,
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    })
    await runUpdate({
      update_id: 8,
      callback_query: {
        id: 'callback-wrong-session',
        from: owner,
        data: 'cgm:p:wrong-session',
        message: {
          message_id: 8,
          message_thread_id: 101,
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    })
    await runUpdate({
      update_id: 9,
      message: {
        message_id: 9,
        message_thread_id: 101,
        text: 'wrong chat',
        from: owner,
        chat: { id: -100999, type: 'supergroup', is_forum: true },
      },
    })
    await runUpdate({
      update_id: 10,
      message: {
        message_id: 10,
        message_thread_id: 101,
        text: 'unauthorized message',
        from: { id: 999, is_bot: false, first_name: 'Someone' },
        chat: { id: -100123, type: 'supergroup', is_forum: true },
      },
    })
    await runUpdate({
      update_id: 11,
      callback_query: {
        id: 'callback-unauthorized',
        from: { id: 999, is_bot: false, first_name: 'Someone' },
        data: 'cgm:p:allow',
        message: {
          message_id: 11,
          message_thread_id: 101,
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    })

    expect(tmuxCalls).toEqual([
      { type: 'text', sessionId: 'session-1', text: 'continue with the tests' },
      { type: 'interrupt', sessionId: 'session-1' },
      { type: 'text', sessionId: 'session-1', text: 'y' },
      { type: 'text', sessionId: 'session-1', text: 'Stable' },
      {
        type: 'text',
        sessionId: 'session-1',
        text: 'Use the custom release channel',
      },
      { type: 'interrupt', sessionId: 'session-1' },
    ])
    expect(callbackAnswers).toEqual([
      { id: 'callback-allow', text: 'Sent to Claude.' },
      { id: 'callback-reply', text: 'Sent to Claude.' },
      { id: 'callback-custom', text: 'Type your reply in the chat.' },
      { id: 'callback-abort', text: 'Session interrupted.' },
      { id: 'callback-wrong-session', text: 'This action has expired.' },
      { id: 'callback-unauthorized', text: 'Not authorized.' },
    ])
  })
})

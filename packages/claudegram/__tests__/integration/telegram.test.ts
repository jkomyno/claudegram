import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inspect } from 'node:util'

import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ClaudegramConfig,
  Config,
  handleTelegramUpdate,
  makeHookEnvelope,
  makeNotifierWithOptions,
  makeSessionRegistry,
  makeTelegramApi,
  makeTopicManager,
  type NotifierOptions,
  Notifier,
  parseHookEvent,
  pollTelegramOnce,
  runTelegramPolling,
  SessionRegistry,
  TelegramApi,
  TelegramApiError,
  TmuxBridge,
  ToolMuteRules,
  TopicManager,
} from '../../src'

interface RecordedCall {
  readonly method: string
  readonly body: Readonly<Record<string, unknown>>
}

interface FakeTelegram {
  readonly baseUrl: string
  readonly calls: Array<RecordedCall>
  failedGetUpdates: number
  failedSendMessages: number
  readonly heldMethods: Set<string>
  updates: ReadonlyArray<unknown>
  readonly close: () => Promise<void>
}

const fakeServers: Array<FakeTelegram> = []

afterEach(async () => {
  await Promise.all(fakeServers.splice(0).map((server) => server.close()))
})

const readRequestBody = async (
  request: import('node:http').IncomingMessage,
): Promise<Readonly<Record<string, unknown>>> => {
  request.setEncoding('utf8')
  let body = ''
  for await (const chunk of request) {
    body += chunk
  }
  return JSON.parse(body) as Readonly<
    Record<string, unknown>
  >
}

const startFakeTelegram = async (): Promise<FakeTelegram> => {
  const calls: Array<RecordedCall> = []
  let topicId = 100
  let messageId = 1000
  let failedGetUpdates = 0
  let failedSendMessages = 0
  const heldMethods = new Set<string>()
  let updates: ReadonlyArray<unknown> = []

  const server = createServer(async (request, response) => {
    const method = request.url?.split('/').at(-1) ?? ''
    const body = await readRequestBody(request)
    calls.push({ method, body })

    if (heldMethods.has(method)) {
      return
    }

    response.setHeader('content-type', 'application/json')

    if (method === 'getUpdates' && failedGetUpdates > 0) {
      failedGetUpdates -= 1
      response.statusCode = 503
      response.end(
        JSON.stringify({ ok: false, description: 'temporarily unavailable' }),
      )
      return
    }

    if (method === 'sendMessage' && failedSendMessages > 0) {
      failedSendMessages -= 1
      response.statusCode = 503
      response.end(
        JSON.stringify({ ok: false, description: 'temporarily unavailable' }),
      )
      return
    }

    let result: unknown
    switch (method) {
      case 'createForumTopic': {
        result = { message_thread_id: ++topicId, name: body.name }
        break
      }
      case 'sendMessage': {
        result = {
          message_id: ++messageId,
          message_thread_id: body.message_thread_id,
          text: body.text,
          chat: { id: body.chat_id, type: 'supergroup', is_forum: true },
          ...(body.reply_markup === undefined
            ? {}
            : { reply_markup: body.reply_markup }),
        }
        break
      }
      case 'getUpdates': {
        result = updates
        break
      }
      default: {
        result = true
      }
    }

    response.end(JSON.stringify({ ok: true, result }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo

  const fake: FakeTelegram = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    get failedGetUpdates() {
      return failedGetUpdates
    },
    set failedGetUpdates(value: number) {
      failedGetUpdates = value
    },
    get failedSendMessages() {
      return failedSendMessages
    },
    set failedSendMessages(value: number) {
      failedSendMessages = value
    },
    heldMethods,
    get updates() {
      return updates
    },
    set updates(value: ReadonlyArray<unknown>) {
      updates = value
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((cause) => {
          if (cause === undefined) {
            resolve()
          } else {
            reject(cause)
          }
        })
        server.closeAllConnections()
      }),
  }
  fakeServers.push(fake)
  return fake
}

const config: ClaudegramConfig = {
  botToken: 'fake-token',
  chatId: -100123,
  ownerUserId: 424242,
  socketPath: '/tmp/claudegram-test.sock',
  topicTtlHours: 72,
  verbose: false,
  configPath: '/tmp/claudegram-test.json',
}

const eventEnvelope = (
  sessionId: string,
  event: Readonly<Record<string, unknown>>,
  sentAt = '2026-08-13T12:00:00.000Z',
  host = 'macbook',
) =>
  makeHookEnvelope(
    parseHookEvent({
      session_id: sessionId,
      cwd: `/work/${sessionId}`,
      ...event,
    }),
    { host, tmuxPane: '%7' },
    new Date(sentAt),
  )

const makeTestServices = async (
  fake: FakeTelegram,
  notifierOptions: NotifierOptions = {},
) => {
  const api = await Effect.runPromise(
    makeTelegramApi({
      botToken: 'fake-token',
      baseUrl: fake.baseUrl,
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  )
  const registry = await Effect.runPromise(makeSessionRegistry)
  const topics = await Effect.runPromise(
    makeTopicManager.pipe(
      Effect.provideService(Config, config),
      Effect.provideService(TelegramApi, api),
      Effect.provideService(SessionRegistry, registry),
    ),
  )
  const muteRules = ToolMuteRules.of({
    isMuted: (event) => Effect.succeed(event.tool_name === 'Read'),
  })
  const notifier = await Effect.runPromise(
    makeNotifierWithOptions(notifierOptions).pipe(
      Effect.provideService(Config, config),
      Effect.provideService(TelegramApi, api),
      Effect.provideService(SessionRegistry, registry),
      Effect.provideService(TopicManager, topics),
      Effect.provideService(ToolMuteRules, muteRules),
    ),
  )

  return { api, registry, topics, notifier }
}

describe('Telegram bridge', () => {
  it('redacts the bot token from transport failures', async () => {
    const botToken = '123456:super-secret-token'
    const api = await Effect.runPromise(
      makeTelegramApi({
        botToken,
        baseUrl: 'http://127.0.0.1:1',
        requestTimeoutMilliseconds: 1_000,
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    )

    const failure = await Effect.runPromise(Effect.flip(api.getMe()))

    expect(failure).toBeInstanceOf(TelegramApiError)
    expect(inspect(failure, { depth: null })).not.toContain(botToken)
  })

  it('formats useful events, buttons, mute rules, and topic cleanup', async () => {
    const fake = await startFakeTelegram()
    const { notifier, topics } = await makeTestServices(fake)

    const firstSession = 'session-one'
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, { hook_event_name: 'SessionStart' }),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, {
          hook_event_name: 'Stop',
          last_assistant_message: 'The implementation **is ready**.',
        }),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'pnpm test' },
        }),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, {
          hook_event_name: 'Notification',
          message: 'Claude needs attention.',
        }),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, { hook_event_name: 'PreCompact' }),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          tool_input: { command: 'git status' },
        }),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              {
                question: 'Which release channel?',
                options: [
                  { label: 'Stable', description: 'Ship broadly' },
                  { label: 'Beta', description: 'Test first' },
                ],
              },
            ],
          },
        }),
      ),
    )
    const muted = await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/work/session-one/README.md' },
        }),
      ),
    )
    const ignored = await Effect.runPromise(
      notifier.notify(
        eventEnvelope(firstSession, {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'continue',
        }),
      ),
    )

    expect(muted.reason).toBe('muted')
    expect(ignored.reason).toBe('not-useful')

    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(
          'session-two',
          { hook_event_name: 'SessionStart' },
          '2026-08-13T12:00:00.000Z',
          'linux-host',
        ),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(
          'stale-session',
          { hook_event_name: 'SessionStart' },
          '2025-01-01T00:00:00.000Z',
        ),
      ),
    )

    const removed = await Effect.runPromise(
      topics.cleanupInactiveBefore(new Date('2026-01-01T00:00:00.000Z')),
    )
    expect(removed.map((topic) => topic.sessionId)).toEqual(['stale-session'])

    const createCalls = fake.calls.filter(
      (call) => call.method === 'createForumTopic',
    )
    const sendCalls = fake.calls.filter((call) => call.method === 'sendMessage')
    const deleteCalls = fake.calls.filter(
      (call) => call.method === 'deleteForumTopic',
    )

    expect(createCalls).toHaveLength(3)
    expect(createCalls[0]?.body.name).toBe('macbook · session-one')
    expect(createCalls[1]?.body.name).toBe('linux-host · session-two')
    expect(sendCalls).toHaveLength(6)
    expect(sendCalls.map((call) => call.body.text)).toEqual([
      '<b>Claude</b>\nThe implementation <b>is ready</b>.',
      '🛠️ Bash: pnpm test',
      '🔔 Claude needs attention.',
      '🧹 Claude is compacting this session.',
      '🔐 Permission requested\nBash: git status',
      '❓ Which release channel?',
    ])
    expect(sendCalls[0]?.body.parse_mode).toBe('HTML')
    expect(sendCalls.slice(1).every((call) => call.body.parse_mode === undefined))
      .toBe(true)
    expect(deleteCalls).toHaveLength(1)

    const permissionMarkup = sendCalls[4]?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{
          readonly callback_data: string
          readonly text: string
        }>
      >
    }
    expect(
      permissionMarkup.inline_keyboard.map((row) =>
        row.map((button) => button.text),
      ),
    ).toEqual([['✅ Allow', '❌ Deny'], ['🛑 Abort']])
    const allowCallback = permissionMarkup.inline_keyboard[0]?.[0]?.callback_data
    const denyCallback = permissionMarkup.inline_keyboard[0]?.[1]?.callback_data
    expect(allowCallback).toMatch(/^cgm:p:/u)
    const permissionAction = await Effect.runPromise(
      notifier.resolveCallback(allowCallback ?? '', firstSession),
    )
    expect(Option.getOrThrow(permissionAction)).toMatchObject({
      type: 'permission',
      sessionId: firstSession,
      toolUseId: 'tool-1',
      decision: 'allow',
    })
    expect(
      Option.isNone(
        await Effect.runPromise(
          notifier.resolveCallback(allowCallback ?? '', firstSession),
        ),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        await Effect.runPromise(
          notifier.resolveCallback(denyCallback ?? '', firstSession),
        ),
      ),
    ).toBe(true)

    const questionMarkup = sendCalls[5]?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{
          readonly callback_data: string
          readonly text: string
        }>
      >
    }
    expect(
      questionMarkup.inline_keyboard.map((row) =>
        row.map((button) => button.text),
      ),
    ).toEqual([['Stable'], ['Beta'], ['✍️ Custom reply', '🛑 Abort']])
    const customReplyCallback =
      questionMarkup.inline_keyboard[2]?.[0]?.callback_data
    const customReplyAction = await Effect.runPromise(
      notifier.resolveCallback(customReplyCallback ?? '', firstSession),
    )
    expect(Option.getOrThrow(customReplyAction)).toEqual({
      type: 'await-reply',
      sessionId: firstSession,
    })
  })

  it('invalidates replaced, sibling, and expired callback buttons', async () => {
    const fake = await startFakeTelegram()
    let currentTime = Date.parse('2026-08-13T12:00:00.000Z')
    const { notifier } = await makeTestServices(fake, {
      now: () => new Date(currentTime),
    })
    const sessionId = 'session-callbacks'
    const permission = () =>
      notifier.notify(
        eventEnvelope(sessionId, {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_use_id: 'tool-reused',
          tool_input: { command: 'pnpm test' },
        }),
      )

    await Effect.runPromise(permission())
    const firstCall = fake.calls.find((call) => call.method === 'sendMessage')
    const firstMarkup = firstCall?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const firstAllow = firstMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ''
    const firstDeny = firstMarkup.inline_keyboard[0]?.[1]?.callback_data ?? ''
    const firstAbort = firstMarkup.inline_keyboard[1]?.[0]?.callback_data ?? ''

    await Effect.runPromise(permission())
    const sendCalls = fake.calls.filter((call) => call.method === 'sendMessage')
    const secondMarkup = sendCalls[1]?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const secondAllow = secondMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ''
    const secondDeny = secondMarkup.inline_keyboard[0]?.[1]?.callback_data ?? ''
    const secondAbort = secondMarkup.inline_keyboard[1]?.[0]?.callback_data ?? ''

    expect(secondAllow).not.toBe(firstAllow)
    expect(
      Option.isNone(
        await Effect.runPromise(
          notifier.resolveCallback(firstAllow, sessionId),
        ),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        await Effect.runPromise(notifier.resolveCallback(firstDeny, sessionId)),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        await Effect.runPromise(notifier.resolveCallback(firstAbort, sessionId)),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        await Effect.runPromise(
          notifier.resolveCallback(secondAllow, 'another-session'),
        ),
      ),
    ).toBe(true)
    expect(
      Option.getOrThrow(
        await Effect.runPromise(
          notifier.resolveCallback(secondAbort, sessionId),
        ),
      ),
    ).toEqual({ type: 'abort', sessionId })
    expect(
      Option.isNone(
        await Effect.runPromise(
          notifier.resolveCallback(secondAllow, sessionId),
        ),
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        await Effect.runPromise(
          notifier.resolveCallback(secondDeny, sessionId),
        ),
      ),
    ).toBe(true)

    await Effect.runPromise(permission())
    const thirdCall = fake.calls
      .filter((call) => call.method === 'sendMessage')
      .at(-1)
    const thirdMarkup = thirdCall?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const thirdAllow = thirdMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ''
    currentTime += 15 * 60 * 1000

    expect(
      Option.isNone(
        await Effect.runPromise(
          notifier.resolveCallback(thirdAllow, sessionId),
        ),
      ),
    ).toBe(true)
  })

  it('keeps a permission callback retryable when tmux delivery fails', async () => {
    const fake = await startFakeTelegram()
    const { api, notifier, registry, topics } = await makeTestServices(fake)
    const sessionId = 'session-permission-retry'

    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(sessionId, { hook_event_name: 'SessionStart' }),
      ),
    )
    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(sessionId, {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'touch /tmp/permission-review' },
        }),
      ),
    )

    const permissionCall = fake.calls.find(
      (call) => call.method === 'sendMessage',
    )
    const threadId = permissionCall?.body.message_thread_id as number
    const markup = permissionCall?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const allowCallback =
      markup.inline_keyboard[0]?.[0]?.callback_data ?? ''
    const attempts: Array<string> = []
    const tmux = TmuxBridge.of({
      hasPane: () => Effect.succeed(true),
      sendText: (_session, text) =>
        Effect.suspend(() => {
          attempts.push(text)
          return attempts.length === 1
            ? Effect.fail(new Error('tmux unavailable'))
            : Effect.void
        }),
      interrupt: () => Effect.void,
    })
    const runCallback = (updateId: number) =>
      Effect.runPromise(
        handleTelegramUpdate({
          update_id: updateId,
          callback_query: {
            id: `callback-${updateId}`,
            from: { id: 424242, is_bot: false, first_name: 'Alberto' },
            data: allowCallback,
            message: {
              message_id: updateId,
              message_thread_id: threadId,
              chat: { id: -100123, type: 'supergroup', is_forum: true },
            },
          },
        }).pipe(
          Effect.provideService(Config, config),
          Effect.provideService(Notifier, notifier),
          Effect.provideService(SessionRegistry, registry),
          Effect.provideService(TelegramApi, api),
          Effect.provideService(TmuxBridge, tmux),
          Effect.provideService(TopicManager, topics),
        ),
      )

    await expect(runCallback(1)).rejects.toThrow(
      'failed to handle Telegram update 1',
    )
    await runCallback(2)

    expect(attempts).toEqual(['y', 'y'])
    expect(
      fake.calls
        .filter((call) => call.method === 'answerCallbackQuery')
        .map((call) => call.body.text),
    ).toEqual(['Sent to Claude.'])
  })

  it('asks multiple questions in order and submits one combined reply', async () => {
    const fake = await startFakeTelegram()
    const { api, notifier, registry, topics } = await makeTestServices(fake)
    const sessionId = 'session-questions'
    const tmuxCalls: Array<{ readonly sessionId: string; readonly text: string }> =
      []
    const tmux = TmuxBridge.of({
      hasPane: () => Effect.succeed(true),
      sendText: (session, text) =>
        Effect.sync(() => {
          tmuxCalls.push({ sessionId: session.id, text })
        }),
      interrupt: () => Effect.void,
    })

    await Effect.runPromise(
      notifier.notify(
        eventEnvelope(sessionId, {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: {
            questions: [
              {
                question: 'Which release channel?',
                options: [{ label: 'Stable' }, { label: 'Beta' }],
              },
              {
                question: 'Which region?',
                options: [{ label: 'Europe' }, { label: 'US' }],
              },
            ],
          },
        }),
      ),
    )

    const runCallback = (
      updateId: number,
      callbackId: string,
      callbackData: string,
      threadId: number,
    ) =>
      Effect.runPromise(
        handleTelegramUpdate({
          update_id: updateId,
          callback_query: {
            id: callbackId,
            from: { id: 424242, is_bot: false, first_name: 'Alberto' },
            data: callbackData,
            message: {
              message_id: updateId,
              message_thread_id: threadId,
              chat: { id: -100123, type: 'supergroup', is_forum: true },
            },
          },
        }).pipe(
          Effect.provideService(Config, config),
          Effect.provideService(Notifier, notifier),
          Effect.provideService(SessionRegistry, registry),
          Effect.provideService(TelegramApi, api),
          Effect.provideService(TmuxBridge, tmux),
          Effect.provideService(TopicManager, topics),
        ),
      )

    const firstSend = fake.calls.find((call) => call.method === 'sendMessage')
    const threadId = firstSend?.body.message_thread_id as number
    const firstMarkup = firstSend?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const stableCallback =
      firstMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ''

    fake.failedSendMessages = 1
    await expect(
      runCallback(1, 'callback-stable-failed', stableCallback, threadId),
    ).rejects.toThrow('failed to handle Telegram update 1')
    await runCallback(2, 'callback-stable-retried', stableCallback, threadId)
    expect(tmuxCalls).toEqual([])

    const sendCalls = fake.calls.filter((call) => call.method === 'sendMessage')
    const secondSend = sendCalls.at(-1)
    const secondMarkup = secondSend?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const europeCallback =
      secondMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ''

    await runCallback(3, 'callback-europe', europeCallback, threadId)

    expect(sendCalls.map((call) => call.body.text)).toEqual([
      '❓ 1/2 Which release channel?',
      '❓ 2/2 Which region?',
      '❓ 2/2 Which region?',
    ])
    expect(tmuxCalls).toEqual([
      { sessionId, text: '1. Stable; 2. Europe' },
    ])
    expect(
      fake.calls
        .filter((call) => call.method === 'answerCallbackQuery')
        .map((call) => call.body.text),
    ).toEqual(['Answer saved.', 'Sent to Claude.'])
  })

  it('long-polls updates and advances the offset', async () => {
    const fake = await startFakeTelegram()
    fake.updates = [
      {
        update_id: 41,
        message: {
          message_id: 7,
          message_thread_id: 101,
          text: 'continue',
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    ]
    const { api } = await makeTestServices(fake)
    const seen: Array<number> = []

    const nextOffset = await Effect.runPromise(
      pollTelegramOnce(40, (update) =>
        Effect.sync(() => {
          seen.push(update.update_id)
        }),
      ).pipe(Effect.provideService(TelegramApi, api)),
    )

    expect(seen).toEqual([41])
    expect(nextOffset).toBe(42)
    expect(fake.calls.at(-1)).toEqual({
      method: 'getUpdates',
      body: {
        offset: 40,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      },
    })
  })

  it('recovers from a transient polling failure', async () => {
    const fake = await startFakeTelegram()
    fake.failedGetUpdates = 1
    fake.updates = [
      {
        update_id: 51,
        message: {
          message_id: 8,
          message_thread_id: 101,
          text: 'continue after retry',
          chat: { id: -100123, type: 'supergroup', is_forum: true },
        },
      },
    ]
    const { api } = await makeTestServices(fake)
    const seen: Array<number> = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const processed = yield* Deferred.make<void>()
          yield* Effect.forkScoped(
            runTelegramPolling(
              (update) =>
                Effect.gen(function* () {
                  seen.push(update.update_id)
                  yield* Deferred.succeed(processed, undefined)
                }),
              {
                initialRetryDelay: '1 millis',
                maximumRetryDelay: '2 millis',
              },
            ).pipe(Effect.provideService(TelegramApi, api)),
          )
          yield* Deferred.await(processed)
        }),
      ),
    )

    expect(seen).toEqual([51])
    expect(
      fake.calls.filter((call) => call.method === 'getUpdates').length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('skips a failed update and advances past later updates', async () => {
    const fake = await startFakeTelegram()
    fake.updates = [
      { update_id: 61 },
      { update_id: 62 },
    ]
    const { api } = await makeTestServices(fake)
    const seen: Array<number> = []

    const nextOffset = await Effect.runPromise(
      pollTelegramOnce(61, (update) => {
        if (update.update_id === 61) {
          return Effect.fail(new Error('poison update'))
        }
        return Effect.sync(() => {
          seen.push(update.update_id)
        })
      }).pipe(Effect.provideService(TelegramApi, api)),
    )

    expect(seen).toEqual([62])
    expect(nextOffset).toBe(63)
  })

  it('times out held-open ordinary and long-poll responses', async () => {
    const fake = await startFakeTelegram()
    fake.heldMethods.add('getMe')
    fake.heldMethods.add('getUpdates')
    const api = await Effect.runPromise(
      makeTelegramApi({
        botToken: 'fake-token',
        baseUrl: fake.baseUrl,
        longPollGraceMilliseconds: 25,
        requestTimeoutMilliseconds: 25,
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    )

    const ordinaryError = await Effect.runPromise(Effect.flip(api.getMe()))
    const longPollError = await Effect.runPromise(
      Effect.flip(api.getUpdates({ timeout: 0 })),
    )

    expect(ordinaryError).toBeInstanceOf(TelegramApiError)
    expect(ordinaryError).toMatchObject({
      method: 'getMe',
      message: 'Telegram API call getMe timed out after 25ms',
    })
    expect(longPollError).toBeInstanceOf(TelegramApiError)
    expect(longPollError).toMatchObject({
      method: 'getUpdates',
      message: 'Telegram API call getUpdates timed out after 25ms',
    })
  })
})

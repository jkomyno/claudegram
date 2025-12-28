import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ClaudegramConfig,
  Config,
  makeHookEnvelope,
  makeNotifier,
  makeSessionRegistry,
  makeTelegramApi,
  makeTopicManager,
  parseHookEvent,
  pollTelegramOnce,
  SessionRegistry,
  TelegramApi,
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
  let updates: ReadonlyArray<unknown> = []

  const server = createServer(async (request, response) => {
    const method = request.url?.split('/').at(-1) ?? ''
    const body = await readRequestBody(request)
    calls.push({ method, body })
    response.setHeader('content-type', 'application/json')

    const result: unknown =
      method === 'createForumTopic'
        ? {
            message_thread_id: ++topicId,
            name: body.name,
          }
        : method === 'sendMessage'
          ? {
              message_id: ++messageId,
              message_thread_id: body.message_thread_id,
              text: body.text,
              chat: { id: body.chat_id, type: 'supergroup', is_forum: true },
              ...(body.reply_markup === undefined
                ? {}
                : { reply_markup: body.reply_markup }),
            }
          : method === 'getUpdates'
            ? updates
            : true

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
      }),
  }
  fakeServers.push(fake)
  return fake
}

const config: ClaudegramConfig = {
  botToken: 'fake-token',
  chatId: -100123,
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

const makeTestServices = async (fake: FakeTelegram) => {
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
    makeNotifier.pipe(
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
          last_assistant_message: 'The implementation is ready.',
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
      'Claude\nThe implementation is ready.',
      '🛠️ Bash: pnpm test',
      '🔔 Claude needs attention.',
      '🧹 Claude is compacting this session.',
      '🔐 Permission requested\nBash: git status',
      '❓ Which release channel?',
    ])
    expect(deleteCalls).toHaveLength(1)

    const permissionMarkup = sendCalls[4]?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const allowCallback = permissionMarkup.inline_keyboard[0]?.[0]?.callback_data
    expect(allowCallback).toMatch(/^cgm:p:/u)
    const permissionAction = await Effect.runPromise(
      notifier.resolveCallback(allowCallback ?? ''),
    )
    expect(Option.getOrThrow(permissionAction)).toMatchObject({
      type: 'permission',
      sessionId: firstSession,
      toolUseId: 'tool-1',
      decision: 'allow',
    })
    expect(
      Option.isNone(
        await Effect.runPromise(notifier.resolveCallback(allowCallback ?? '')),
      ),
    ).toBe(true)

    const questionMarkup = sendCalls[5]?.body.reply_markup as {
      readonly inline_keyboard: ReadonlyArray<
        ReadonlyArray<{ readonly callback_data: string }>
      >
    }
    const replyCallback = questionMarkup.inline_keyboard[0]?.[0]?.callback_data
    const replyAction = await Effect.runPromise(
      notifier.resolveCallback(replyCallback ?? ''),
    )
    expect(Option.getOrThrow(replyAction)).toEqual({
      type: 'reply',
      sessionId: firstSession,
      text: 'Stable',
    })
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
})

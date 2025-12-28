import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import * as Effect from 'effect/Effect'
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
  SessionRegistry,
  TelegramApi,
  ToolMuteRules,
  TopicManager,
} from '../../src'

interface BotRequest {
  readonly token: string
  readonly method: string
  readonly body: Readonly<Record<string, unknown>>
}

const servers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()))
})

describe('multi-host parity', () => {
  it('keeps separate bot traffic in one shared supergroup', async () => {
    const requests: Array<BotRequest> = []
    let topicId = 200
    const server = createServer(async (request, response) => {
      request.setEncoding('utf8')
      let input = ''
      for await (const chunk of request) input += chunk
      const [, token = '', method = ''] = request.url?.match(/^\/bot([^/]+)\/(.+)$/u) ?? []
      const body = JSON.parse(input) as Readonly<Record<string, unknown>>
      requests.push({ token, method, body })
      const result =
        method === 'createForumTopic'
          ? { message_thread_id: ++topicId, name: body.name }
          : {
              message_id: topicId + 1000,
              message_thread_id: body.message_thread_id,
              text: body.text,
              chat: { id: body.chat_id, type: 'supergroup', is_forum: true },
            }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, result }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    servers.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((cause) => (cause === undefined ? resolve() : reject(cause)))
        }),
    )
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`

    const notifyFromHost = async (host: string, botToken: string) => {
      const config: ClaudegramConfig = {
        botToken,
        chatId: -100123,
        socketPath: `/tmp/${host}.sock`,
        topicTtlHours: 72,
        verbose: false,
        configPath: `/tmp/${host}.json`,
      }
      const api = await Effect.runPromise(
        makeTelegramApi({ botToken, baseUrl }).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      )
      const registry = await Effect.runPromise(makeSessionRegistry)
      const topics = await Effect.runPromise(
        makeTopicManager.pipe(
          Effect.provideService(Config, config),
          Effect.provideService(TelegramApi, api),
          Effect.provideService(SessionRegistry, registry),
        ),
      )
      const notifier = await Effect.runPromise(
        makeNotifier.pipe(
          Effect.provideService(Config, config),
          Effect.provideService(TelegramApi, api),
          Effect.provideService(SessionRegistry, registry),
          Effect.provideService(TopicManager, topics),
          Effect.provideService(
            ToolMuteRules,
            ToolMuteRules.of({ isMuted: () => Effect.succeed(false) }),
          ),
        ),
      )
      const envelope = makeHookEnvelope(
        parseHookEvent({
          session_id: `${host}-session`,
          hook_event_name: 'Notification',
          cwd: `/work/${host}`,
          message: `hello from ${host}`,
        }),
        { host, tmuxPane: '%1' },
      )
      await Effect.runPromise(notifier.notify(envelope))
    }

    await Promise.all([
      notifyFromHost('macbook', 'mac-token'),
      notifyFromHost('linux-box', 'linux-token'),
    ])

    const sends = requests.filter((request) => request.method === 'sendMessage')
    expect(new Set(sends.map((request) => request.token))).toEqual(
      new Set(['mac-token', 'linux-token']),
    )
    expect(sends.every((request) => request.body.chat_id === -100123)).toBe(true)
    expect(new Set(sends.map((request) => request.body.message_thread_id)).size).toBe(2)
  })
})

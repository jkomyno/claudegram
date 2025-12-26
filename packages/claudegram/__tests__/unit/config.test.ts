import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src'

describe('loadConfig', () => {
  it('applies environment values over file values over defaults', async () => {
    const config = await Effect.runPromise(
      loadConfig({
        homeDirectory: '/tmp/claudegram-home',
        env: {
          CLAUDEGRAM_BOT_TOKEN: 'env-token',
          CLAUDEGRAM_SOCKET_PATH: '/tmp/from-env.sock',
          CLAUDEGRAM_VERBOSE: 'true',
        },
        file: {
          botToken: 'file-token',
          chatId: -100123,
          socketPath: '/tmp/from-file.sock',
          topicTtlHours: 24,
          verbose: false,
          configPath: '/ignored/by-loader.json',
        },
      }),
    )

    expect(config).toEqual({
      botToken: 'env-token',
      chatId: -100123,
      configPath: '/tmp/claudegram-home/.config/claudegram/config.json',
      socketPath: '/tmp/from-env.sock',
      topicTtlHours: 24,
      verbose: true,
    })
  })

  it('uses the documented 72 hour topic lifetime by default', async () => {
    const config = await Effect.runPromise(
      loadConfig({
        homeDirectory: '/tmp/claudegram-home',
        env: {},
        file: {},
      }),
    )

    expect(config.topicTtlHours).toBe(72)
  })
})

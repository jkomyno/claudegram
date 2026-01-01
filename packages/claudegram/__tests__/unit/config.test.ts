import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../../src'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const loadConfigError = async (
  text: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ConfigError> => {
  const directory = await mkdtemp(join(tmpdir(), 'claudegram-config-'))
  temporaryDirectories.push(directory)
  const configPath = join(directory, 'config.json')
  await writeFile(configPath, text)

  return Effect.runPromise(
    Effect.flip(
      loadConfig({
        homeDirectory: directory,
        env: { ...env, CLAUDEGRAM_CONFIG: configPath },
      }),
    ),
  )
}

describe('loadConfig', () => {
  it('applies environment values over file values over defaults', async () => {
    const config = await Effect.runPromise(
      loadConfig({
        homeDirectory: '/tmp/claudegram-home',
        env: {
          CLAUDEGRAM_BOT_TOKEN: 'env-token',
          CLAUDEGRAM_OWNER_USER_ID: '789',
          CLAUDEGRAM_SOCKET_PATH: '/tmp/from-env.sock',
          CLAUDEGRAM_VERBOSE: 'true',
        },
        file: {
          botToken: 'file-token',
          chatId: -100123,
          ownerUserId: 456,
          socketPath: '/tmp/from-file.sock',
          topicTtlHours: 24,
          verbose: false,
        },
      }),
    )

    expect(config).toEqual({
      botToken: 'env-token',
      chatId: -100123,
      ownerUserId: 789,
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

  it('preserves the schema parse cause for malformed JSON', async () => {
    const error = await loadConfigError('{')

    expect(error).toBeInstanceOf(ConfigError)
    expect(error.cause).toBeDefined()
  })

  it.each([
    ['botToken', 123],
    ['chatId', '-100123'],
    ['ownerUserId', '123'],
    ['socketPath', false],
    ['topicTtlHours', '24'],
    ['verbose', 'false'],
  ])('rejects a wrong primitive type for %s', async (key, value) => {
    expect(await loadConfigError(JSON.stringify({ [key]: value }))).toBeInstanceOf(
      ConfigError,
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid Telegram owner user id (%s)',
    async (ownerUserId) => {
      expect(
        await loadConfigError(JSON.stringify({ ownerUserId })),
      ).toBeInstanceOf(ConfigError)
    },
  )

  it.each([0, -1])(
    'rejects a non-positive topic TTL from the config file (%s)',
    async (topicTtlHours) => {
      expect(
        await loadConfigError(JSON.stringify({ topicTtlHours })),
      ).toBeInstanceOf(ConfigError)
    },
  )

  it.each(['0', '-1', 'NaN', 'Infinity'])(
    'rejects a non-positive or non-finite topic TTL from the environment (%s)',
    async (topicTtlHours) => {
      expect(
        await loadConfigError(JSON.stringify({ topicTtlHours: 24 }), {
          CLAUDEGRAM_TOPIC_TTL_HOURS: topicTtlHours,
        }),
      ).toBeInstanceOf(ConfigError)
    },
  )
})

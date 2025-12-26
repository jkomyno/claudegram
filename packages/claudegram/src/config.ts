import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

export interface ClaudegramConfig {
  readonly botToken?: string
  readonly chatId?: number
  readonly socketPath: string
  readonly topicTtlHours: number
  readonly verbose: boolean
  readonly configPath: string
}

export interface ConfigLoadOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly homeDirectory?: string
  readonly file?: Partial<ClaudegramConfig>
}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class Config extends Context.Tag('@claudegram/Config')<
  Config,
  ClaudegramConfig
>() {}

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback
  }

  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) {
    return false
  }

  throw new ConfigError({ message: 'CLAUDEGRAM_VERBOSE must be true or false' })
}

const parsePositiveNumber = (
  value: string | undefined,
  fallback: number,
  variable: string,
): number => {
  if (value === undefined) {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError({ message: `${variable} must be a positive number` })
  }

  return parsed
}

const parseChatId = (
  value: string | number | undefined,
): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError({ message: 'Telegram chat id must be an integer' })
  }

  return parsed
}

const readConfigFile = async (
  configPath: string,
): Promise<Partial<ClaudegramConfig>> => {
  try {
    const value: unknown = JSON.parse(await readFile(configPath, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ConfigError({ message: `${configPath} must contain a JSON object` })
    }

    return value as Partial<ClaudegramConfig>
  } catch (cause) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 'ENOENT'
    ) {
      return {}
    }

    throw cause
  }
}

export const loadConfig = (
  options: ConfigLoadOptions = {},
): Effect.Effect<ClaudegramConfig, ConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const env = options.env ?? process.env
      const homeDirectory = options.homeDirectory ?? homedir()
      const configRoot = env.XDG_CONFIG_HOME ?? join(homeDirectory, '.config')
      const stateRoot = env.XDG_STATE_HOME ?? join(homeDirectory, '.local', 'state')
      const configPath =
        env.CLAUDEGRAM_CONFIG ?? join(configRoot, 'claudegram', 'config.json')
      const file = options.file ?? (await readConfigFile(configPath))
      const topicTtlHours = parsePositiveNumber(
        env.CLAUDEGRAM_TOPIC_TTL_HOURS,
        file.topicTtlHours ?? 72,
        'CLAUDEGRAM_TOPIC_TTL_HOURS',
      )
      const chatId = parseChatId(env.CLAUDEGRAM_CHAT_ID ?? file.chatId)
      const botToken = env.CLAUDEGRAM_BOT_TOKEN ?? file.botToken

      return {
        configPath,
        socketPath:
          env.CLAUDEGRAM_SOCKET_PATH ??
          file.socketPath ??
          join(stateRoot, 'claudegram', 'daemon.sock'),
        topicTtlHours,
        verbose: parseBoolean(
          env.CLAUDEGRAM_VERBOSE,
          file.verbose ?? false,
        ),
        ...(botToken === undefined ? {} : { botToken }),
        ...(chatId === undefined ? {} : { chatId }),
      }
    },
    catch: (cause) =>
      cause instanceof ConfigError
        ? cause
        : new ConfigError({ message: 'failed to load claudegram config', cause }),
  })

export const ConfigLive = Layer.effect(Config, loadConfig())

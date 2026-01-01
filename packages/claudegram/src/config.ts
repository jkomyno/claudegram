import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { isMissingFile } from './node-errors'

const TopicTtlHoursSchema = Schema.Number.pipe(
  Schema.finite(),
  Schema.greaterThan(0),
)

const TelegramChatIdSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.filter(Number.isSafeInteger, {
    description: 'a safe integer Telegram chat id',
  }),
)

const TelegramUserIdSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.filter(Number.isSafeInteger, {
    description: 'a safe positive integer Telegram user id',
  }),
)

export const PersistedConfigSchema = Schema.Struct({
  botToken: Schema.optional(Schema.String),
  chatId: Schema.optional(TelegramChatIdSchema),
  ownerUserId: Schema.optional(TelegramUserIdSchema),
  socketPath: Schema.optional(Schema.String),
  topicTtlHours: Schema.optional(TopicTtlHoursSchema),
  verbose: Schema.optional(Schema.Boolean),
})

export type PersistedConfig = typeof PersistedConfigSchema.Type

const PersistedConfigJsonSchema = Schema.parseJson(PersistedConfigSchema, {
  space: 2,
})

export interface ClaudegramConfig {
  readonly botToken?: string
  readonly chatId?: number
  readonly ownerUserId?: number
  readonly socketPath: string
  readonly topicTtlHours: number
  readonly verbose: boolean
  readonly configPath: string
}

export interface ConfigLoadOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly homeDirectory?: string
  readonly file?: PersistedConfig
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

const parseOwnerUserId = (
  value: string | number | undefined,
): number | undefined => {
  if (value === undefined) return undefined

  try {
    return Schema.decodeUnknownSync(TelegramUserIdSchema)(Number(value))
  } catch (cause) {
    throw new ConfigError({
      message: 'Telegram owner user id must be a positive integer',
      cause,
    })
  }
}

const readConfigFile = async (
  configPath: string,
): Promise<PersistedConfig> => {
  try {
    return Schema.decodeUnknownSync(PersistedConfigJsonSchema)(
      await readFile(configPath, 'utf8'),
    )
  } catch (cause) {
    if (isMissingFile(cause)) {
      return {}
    }

    throw new ConfigError({
      message: `failed to read ${configPath}`,
      cause,
    })
  }
}

const decodeConfigFile = (value: PersistedConfig): PersistedConfig => {
  try {
    return Schema.decodeUnknownSync(PersistedConfigSchema)(value)
  } catch (cause) {
    throw new ConfigError({ message: 'invalid provided config file', cause })
  }
}

export const encodePersistedConfig = (config: PersistedConfig): string =>
  Schema.encodeSync(PersistedConfigJsonSchema)(config)

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
      const file =
        options.file === undefined
          ? await readConfigFile(configPath)
          : decodeConfigFile(options.file)
      const topicTtlHours = parsePositiveNumber(
        env.CLAUDEGRAM_TOPIC_TTL_HOURS,
        file.topicTtlHours ?? 72,
        'CLAUDEGRAM_TOPIC_TTL_HOURS',
      )
      const chatId = parseChatId(env.CLAUDEGRAM_CHAT_ID ?? file.chatId)
      const ownerUserId = parseOwnerUserId(
        env.CLAUDEGRAM_OWNER_USER_ID ?? file.ownerUserId,
      )
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
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
      }
    },
    catch: (cause) =>
      cause instanceof ConfigError
        ? cause
        : new ConfigError({ message: 'failed to load claudegram config', cause }),
  })

export const ConfigLive = Layer.effect(Config, loadConfig())

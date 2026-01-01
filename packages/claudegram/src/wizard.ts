import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type * as HttpClient from '@effect/platform/HttpClient'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

import {
  type ClaudegramConfig,
  encodePersistedConfig,
  type PersistedConfig,
} from './config'
import { startDaemon, type DaemonState } from './daemon'
import { installHooks, type HookSettingsResult } from './hook-settings'
import {
  makeTelegramApi,
  type TelegramApiService,
  type TelegramUpdate,
} from './telegram-api'

export interface WizardPrompt {
  readonly secret: (message: string) => Promise<string>
  readonly text: (message: string) => Promise<string>
  readonly confirm: (message: string, defaultValue: boolean) => Promise<boolean>
  readonly note: (message: string) => Promise<void>
}

export interface WizardResult {
  readonly botUsername?: string
  readonly chatId: number
  readonly ownerUserId: number
  readonly configPath: string
  readonly hooks: HookSettingsResult
  readonly daemon: DaemonState | undefined
}

export class WizardError extends Data.TaggedError('WizardError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface WizardOptions {
  readonly prompt: WizardPrompt
  readonly baseConfig: ClaudegramConfig
  readonly makeApi?: (
    token: string,
  ) => Effect.Effect<TelegramApiService, unknown, HttpClient.HttpClient>
  readonly installManagedHooks?: typeof installHooks
  readonly launchDaemon?: typeof startDaemon
  readonly setupCode?: () => string
}

const writeConfig = async (
  config: ClaudegramConfig,
  botToken: string,
  chatId: number,
  ownerUserId: number,
): Promise<void> => {
  await mkdir(dirname(config.configPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${config.configPath}.${process.pid}.tmp`
  const persistedConfig: PersistedConfig = {
    botToken,
    chatId,
    ownerUserId,
    socketPath: config.socketPath,
    topicTtlHours: config.topicTtlHours,
    verbose: config.verbose,
  }
  await writeFile(
    temporaryPath,
    `${encodePersistedConfig(persistedConfig)}\n`,
    { mode: 0o600 },
  )
  await rename(temporaryPath, config.configPath)
}

interface TelegramSetupTarget {
  readonly chatId: number
  readonly chatTitle: string
  readonly ownerUserId: number
}

const setupCommandMatches = (text: string, setupCode: string): boolean => {
  const [command, code, ...extra] = text.trim().split(/\s+/)
  return (
    command?.split('@')[0] === '/claudegram_setup' &&
    code === setupCode &&
    extra.length === 0
  )
}

const setupTargets = (
  updates: ReadonlyArray<TelegramUpdate>,
  setupCode: string,
): ReadonlyArray<TelegramSetupTarget> => {
  const targets = new Map<string, TelegramSetupTarget>()
  for (const update of updates) {
    const message = update.message
    const sender = message?.from
    const chat = message?.chat
    if (
      message?.text !== undefined &&
      sender !== undefined &&
      sender.is_bot !== true &&
      chat?.is_forum === true &&
      setupCommandMatches(message.text, setupCode)
    ) {
      targets.set(`${chat.id}:${sender.id}`, {
        chatId: chat.id,
        chatTitle: chat.title ?? String(chat.id),
        ownerUserId: sender.id,
      })
    }
  }
  return Array.from(targets.values())
}

export const runSetupWizard = (
  options: WizardOptions,
): Effect.Effect<WizardResult, WizardError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const token = (yield* Effect.promise(() =>
      options.prompt.secret('Telegram bot token'),
    )).trim()
    if (token.length === 0) {
      return yield* new WizardError({ message: 'Bot token cannot be empty.' })
    }

    const api = yield* (options.makeApi?.(token) ??
      makeTelegramApi({ botToken: token }))
    const bot = yield* api.getMe()
    const setupCode = options.setupCode?.() ?? randomUUID().slice(0, 8)
    const setupCommand = `/claudegram_setup${
      bot.username === undefined ? '' : `@${bot.username}`
    } ${setupCode}`
    yield* Effect.promise(() =>
      options.prompt.note(
        `Connected to @${bot.username ?? bot.first_name}. Add it to the Telegram supergroup with topics, then send this command there from your own account:\n\n${setupCommand}\n\nThis discovers the group and authorizes your Telegram account.`,
      ),
    )
    yield* Effect.promise(() =>
      options.prompt.text('Press Enter after sending the setup command'),
    )

    const updates = yield* api.getUpdates({ timeout: 0 })
    const targets = setupTargets(updates, setupCode)
    if (targets.length === 0) {
      return yield* new WizardError({
        message: `No matching setup command was found. Send ${setupCommand} in the forum supergroup and try again.`,
      })
    }
    if (targets.length > 1) {
      return yield* new WizardError({
        message: 'The setup command matched more than one group or sender. Run setup again with the new command.',
      })
    }
    const target = targets[0]
    if (target === undefined) {
      return yield* new WizardError({ message: 'Telegram setup was not found.' })
    }
    const { chatId, ownerUserId } = target
    yield* Effect.promise(() =>
      options.prompt.note(
        `Using ${target.chatTitle} (${chatId}). Authorized Telegram user: ${ownerUserId}.`,
      ),
    )

    const config: ClaudegramConfig = {
      ...options.baseConfig,
      botToken: token,
      chatId,
      ownerUserId,
    }
    yield* Effect.tryPromise({
      try: () => writeConfig(config, token, chatId, ownerUserId),
      catch: (cause) =>
        new WizardError({ message: 'Failed to write the config file.', cause }),
    })
    const hooks = yield* (options.installManagedHooks ?? installHooks)({
      scope: 'global',
    })
    const shouldStart = yield* Effect.promise(() =>
      options.prompt.confirm('Start the claudegram daemon now?', true),
    )
    const daemon = shouldStart
      ? yield* (options.launchDaemon ?? startDaemon)(config)
      : undefined

    return {
      ...(bot.username === undefined ? {} : { botUsername: bot.username }),
      chatId,
      ownerUserId,
      configPath: config.configPath,
      hooks,
      daemon,
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof WizardError
        ? cause
        : new WizardError({ message: 'Setup did not complete.', cause }),
    ),
  )

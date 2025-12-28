import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type * as HttpClient from '@effect/platform/HttpClient'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

import type { ClaudegramConfig } from './config'
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
}

const writeConfig = async (
  config: ClaudegramConfig,
  botToken: string,
  chatId: number,
): Promise<void> => {
  await mkdir(dirname(config.configPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${config.configPath}.${process.pid}.tmp`
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        botToken,
        chatId,
        socketPath: config.socketPath,
        topicTtlHours: config.topicTtlHours,
        verbose: config.verbose,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  await rename(temporaryPath, config.configPath)
}

const forumChats = (
  updates: ReadonlyArray<TelegramUpdate>,
): ReadonlyArray<{ readonly id: number; readonly title: string }> => {
  const chats = new Map<number, string>()
  for (const update of updates) {
    const chat = update.message?.chat ?? update.callback_query?.message?.chat
    if (chat?.is_forum === true) {
      chats.set(chat.id, chat.title ?? String(chat.id))
    }
  }
  return Array.from(chats, ([id, title]) => ({ id, title }))
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
    yield* Effect.promise(() =>
      options.prompt.note(
        `Connected to @${bot.username ?? bot.first_name}. Add it to a Telegram supergroup with topics, send a message there, then continue.`,
      ),
    )
    yield* Effect.promise(() => options.prompt.text('Press Enter after sending the message'))

    const updates = yield* api.getUpdates({ timeout: 0 })
    const chats = forumChats(updates)
    if (chats.length === 0) {
      return yield* new WizardError({
        message: 'No forum supergroup was found in the bot updates.',
      })
    }

    let chatId: number
    if (chats.length === 1) {
      chatId = chats[0]?.id ?? 0
      yield* Effect.promise(() =>
        options.prompt.note(`Using ${chats[0]?.title ?? chatId} (${chatId}).`),
      )
    } else {
      yield* Effect.promise(() =>
        options.prompt.note(
          chats.map((chat) => `${chat.id}: ${chat.title}`).join('\n'),
        ),
      )
      const selected = yield* Effect.promise(() =>
        options.prompt.text('Telegram chat id'),
      )
      chatId = Number(selected)
      if (!chats.some((chat) => chat.id === chatId)) {
        return yield* new WizardError({
          message: 'The selected chat id was not found in recent bot updates.',
        })
      }
    }

    const config: ClaudegramConfig = {
      ...options.baseConfig,
      botToken: token,
      chatId,
    }
    yield* Effect.tryPromise({
      try: () => writeConfig(config, token, chatId),
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

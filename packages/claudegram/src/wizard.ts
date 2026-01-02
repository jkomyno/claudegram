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

const runPrompt = <A>(operation: () => Promise<A>): Effect.Effect<A, WizardError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new WizardError({
        message:
          cause instanceof Error ? cause.message : 'Interactive setup failed.',
        cause,
      }),
  })

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
    yield* runPrompt(() =>
      options.prompt.note(
        [
          'Step 1 of 4 — Create your Telegram bot',
          '',
          '1. Open @BotFather in Telegram.',
          '2. Send /newbot.',
          '3. Choose a display name and a username ending in "bot".',
          '4. Copy the API token BotFather gives you.',
          '',
          'The token is entered privately and is stored only in your user config.',
        ].join('\n'),
      ),
    )
    const token = (yield* runPrompt(() =>
      options.prompt.secret('Telegram bot token'),
    )).trim()
    if (token.length === 0) {
      return yield* new WizardError({ message: 'Bot token cannot be empty.' })
    }

    const api = yield* (options.makeApi?.(token) ??
      makeTelegramApi({ botToken: token }))
    const bot = yield* api.getMe()
    const botName = bot.username ?? bot.first_name

    yield* runPrompt(() =>
      options.prompt.note(
        [
          `Connected to @${botName}.`,
          '',
          'Step 2 of 4 — Disable privacy mode',
          '',
          '1. Open @BotFather and send /mybots.',
          `2. Select @${botName}.`,
          '3. Open Bot Settings, then Group Privacy.',
          '4. Turn privacy mode off so Telegram messages can reach Claude.',
        ].join('\n'),
      ),
    )

    let privacyModeDisabled = false
    while (!privacyModeDisabled) {
      privacyModeDisabled = yield* runPrompt(() =>
        options.prompt.confirm(
          `Have you disabled privacy mode for @${botName}?`,
          false,
        ),
      )
      if (!privacyModeDisabled) {
        yield* runPrompt(() =>
          options.prompt.note(
            'Privacy mode must be disabled before setup can continue. Complete the BotFather step, then answer yes.',
          ),
        )
      }
    }

    const setupCode = options.setupCode?.() ?? randomUUID().slice(0, 8)
    const setupCommand = `/claudegram_setup${
      bot.username === undefined ? '' : `@${bot.username}`
    } ${setupCode}`
    yield* runPrompt(() =>
      options.prompt.note(
        [
          'Step 3 of 4 — Create or prepare a forum',
          '',
          'Use an existing supergroup:',
          `1. Add @${botName}.`,
          '2. Enable Topics in the group settings.',
          '3. Make the bot an admin with Post Messages and Manage Topics permissions.',
          '',
          'Or create a new group:',
          `1. Create the group and add @${botName}.`,
          '2. Enable Topics to turn it into a forum supergroup.',
          '3. Make the bot an admin with Post Messages and Manage Topics permissions.',
          '',
          'When the forum is ready, send this command there from your own account:',
          '',
          setupCommand,
          '',
          'This discovers the forum and authorizes your Telegram account.',
        ].join('\n'),
      ),
    )
    yield* runPrompt(() =>
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
    yield* runPrompt(() =>
      options.prompt.note(
        [
          `Using ${target.chatTitle} (${chatId}). Authorized Telegram user: ${ownerUserId}.`,
          '',
          'Step 4 of 4 — Verify bot permissions',
          '',
          'Sending a test message to confirm that the bot can post in the forum.',
        ].join('\n'),
      ),
    )
    yield* api
      .sendMessage({
        chatId,
        text: 'claudegram Telegram setup check passed. This bot can post in this forum.',
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WizardError({
              message:
                'The bot could not post in the forum. Make it an admin with Post Messages and Manage Topics permissions, then run setup again.',
              cause,
            }),
        ),
      )
    yield* runPrompt(() =>
      options.prompt.note(
        `Telegram setup verified. The bot can post in ${target.chatTitle}.`,
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
    const shouldStart = yield* runPrompt(() =>
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

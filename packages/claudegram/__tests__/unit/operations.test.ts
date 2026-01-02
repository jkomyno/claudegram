import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ClaudegramConfig,
  daemonPaths,
  inspectDaemon,
  inspectService,
  installService,
  makeSessionRegistry,
  runDoctor,
  runSetupWizard,
  SessionRegistry,
  startHookIngress,
  TelegramApi,
  uninstallService,
} from '../../src'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const makeConfig = (directory: string): ClaudegramConfig => ({
  botToken: 'fake-token',
  chatId: -100123,
  ownerUserId: 424242,
  socketPath: join(directory, 'state', 'daemon.sock'),
  topicTtlHours: 72,
  verbose: false,
  configPath: join(directory, 'config', 'config.json'),
})

describe('operations', () => {
  it('reports a daemon as running only when its pid and socket are live', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-daemon-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)
    const paths = daemonPaths(config)
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(paths.stateDirectory, { recursive: true }),
    )
    const identityToken = 'test-daemon-identity'
    await writeFile(
      paths.pidPath,
      `${JSON.stringify({ pid: process.pid, token: identityToken })}\n`,
    )
    const registry = await Effect.runPromise(makeSessionRegistry)
    const ingress = await Effect.runPromise(
      startHookIngress(config.socketPath, { identityToken }).pipe(
        Effect.provideService(SessionRegistry, registry),
      ),
    )

    try {
      expect(await Effect.runPromise(inspectDaemon(config))).toEqual({
        status: 'running',
        pid: process.pid,
      })

      await writeFile(
        paths.pidPath,
        `${JSON.stringify({ pid: process.pid, token: 'wrong-token' })}\n`,
      )
      expect(await Effect.runPromise(inspectDaemon(config))).toEqual({
        status: 'degraded',
        pid: process.pid,
      })
    } finally {
      await Effect.runPromise(ingress.close)
    }

    expect(await Effect.runPromise(inspectDaemon(config))).toEqual({
      status: 'degraded',
      pid: process.pid,
    })
  })

  it('writes launchd and systemd definitions without activating them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-service-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)

    const launchd = await Effect.runPromise(
      installService(config, {
        homeDirectory: directory,
        platform: 'darwin',
        invocationCommand: "'/opt/claudegram' daemon",
        executeCommands: false,
      }),
    )
    expect(await readFile(launchd.servicePath, 'utf8')).toContain(
      '<key>KeepAlive</key>',
    )
    expect(
      await Effect.runPromise(
        inspectService({ homeDirectory: directory, platform: 'darwin' }),
      ),
    ).toMatchObject({ installed: true })
    expect(
      await Effect.runPromise(
        uninstallService({
          homeDirectory: directory,
          platform: 'darwin',
          executeCommands: false,
        }),
      ),
    ).toMatchObject({ installed: false })

    const systemd = await Effect.runPromise(
      installService(config, {
        homeDirectory: directory,
        platform: 'linux',
        invocationCommand: "'/opt/claudegram' daemon",
        executeCommands: false,
      }),
    )
    const unit = await readFile(systemd.servicePath, 'utf8')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('diagnoses missing Telegram credentials, a dead socket, and missing tmux', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-doctor-'))
    temporaryDirectories.push(directory)
    const report = await Effect.runPromise(
      runDoctor({
        config: {
          ...makeConfig(directory),
          botToken: undefined,
          ownerUserId: undefined,
        },
        homeDirectory: directory,
        tmuxExecutable: join(directory, 'missing-tmux'),
        inspectDaemonState: () => Effect.succeed({ status: 'stopped' }),
      }),
    )

    expect(report.healthy).toBe(false)
    expect(
      report.checks
        .filter((check) => check.status === 'fail')
        .map((check) => check.name),
    ).toEqual(['bot-token', 'owner-user-id', 'daemon', 'tmux'])
  })

  it('runs setup from token discovery through hooks and daemon launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-wizard-'))
    temporaryDirectories.push(directory)
    const notes: Array<string> = []
    const answers = ['fake-token', '']
    const api = TelegramApi.of({
      getMe: () =>
        Effect.succeed({
          id: 1,
          is_bot: true,
          first_name: 'Claudegram',
          username: 'claudegram_test_bot',
        }),
      getUpdates: () =>
        Effect.succeed([
          {
            update_id: 1,
            message: {
              message_id: 1,
              text: 'unrelated old message',
              from: {
                id: 999,
                is_bot: false,
                first_name: 'Someone',
              },
              chat: {
                id: -100999,
                title: 'Wrong group',
                type: 'supergroup',
                is_forum: true,
              },
            },
          },
          {
            update_id: 2,
            message: {
              message_id: 2,
              text: '/claudegram_setup@claudegram_test_bot setup-code',
              from: {
                id: 424242,
                is_bot: false,
                first_name: 'Alberto',
              },
              chat: {
                id: -100123,
                title: 'Test group',
                type: 'supergroup',
                is_forum: true,
              },
            },
          },
        ]),
      sendMessage: () => Effect.die('not used'),
      createForumTopic: () => Effect.die('not used'),
      deleteForumTopic: () => Effect.void,
      answerCallbackQuery: () => Effect.void,
    })

    const result = await Effect.runPromise(
      runSetupWizard({
        baseConfig: makeConfig(directory),
        prompt: {
          secret: async () => answers.shift() ?? '',
          text: async () => answers.shift() ?? '',
          confirm: async () => true,
          note: async (message) => {
            notes.push(message)
          },
        },
        makeApi: () => Effect.succeed(api),
        setupCode: () => 'setup-code',
        installManagedHooks: () =>
          Effect.succeed({
            settingsPath: join(directory, '.claude', 'settings.json'),
            changed: true,
            eventCount: 8,
          }),
        launchDaemon: () =>
          Effect.succeed({ status: 'running', pid: 12345 }),
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    )

    expect(result).toMatchObject({
      botUsername: 'claudegram_test_bot',
      chatId: -100123,
      ownerUserId: 424242,
      daemon: { status: 'running', pid: 12345 },
    })
    expect(notes[0]).toContain(
      '/claudegram_setup@claudegram_test_bot setup-code',
    )
    expect(notes.at(-1)).toBe(
      'Using Test group (-100123). Authorized Telegram user: 424242.',
    )
    const saved = JSON.parse(await readFile(result.configPath, 'utf8')) as {
      readonly botToken: string
      readonly chatId: number
      readonly ownerUserId: number
    }
    expect(saved).toMatchObject({
      botToken: 'fake-token',
      chatId: -100123,
      ownerUserId: 424242,
    })
  })
})

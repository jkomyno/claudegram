import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunContext } from '@effect/platform-bun'
import {
  CLAUDEGRAM_HOOK_EVENTS,
  makeSessionRegistry,
  SessionRegistry,
  startHookIngress,
} from '@claudegram/core'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../../src/commands'
import { CLI_NAME, CLI_VERSION } from '../../src/constants'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const run = (arguments_: ReadonlyArray<string>) =>
  Effect.runPromise(
    runCli(['node', 'claudegram', ...arguments_]).pipe(
      Effect.provide(BunContext.layer),
    ),
  )

const captureOutput = (): { readonly output: Array<string> } => {
  const output: Array<string> = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  return { output }
}

describe('CLI', () => {
  it('names the CLI', () => {
    expect(CLI_NAME).toBe('claudegram')
  })

  it('runs the version command', async () => {
    const { output } = captureOutput()
    await run(['version'])

    expect(output.join('')).toBe(`${CLI_VERSION}\n`)
  })

  it('prints machine-readable daemon status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-cli-'))
    temporaryDirectories.push(directory)
    vi.stubEnv('CLAUDEGRAM_CONFIG', join(directory, 'missing-config.json'))
    vi.stubEnv('CLAUDEGRAM_SOCKET_PATH', join(directory, 'daemon.sock'))
    const { output } = captureOutput()

    await run(['status', '--json'])

    expect(JSON.parse(output.join(''))).toMatchObject({
      status: 'stopped',
      stateDirectory: directory,
      snapshotPath: join(directory, 'daemon-state.json'),
    })
  })

  it('rejects non-interactive setup without required config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-cli-'))
    temporaryDirectories.push(directory)
    vi.stubEnv('CLAUDEGRAM_CONFIG', join(directory, 'missing-config.json'))
    vi.stubEnv('CLAUDEGRAM_BOT_TOKEN', undefined)
    vi.stubEnv('CLAUDEGRAM_CHAT_ID', undefined)

    await expect(run(['setup', '--no-input'])).rejects.toThrow(
      '--no-input requires a bot token and chat id',
    )
  })

  it('honors project scope when installing hooks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-cli-'))
    temporaryDirectories.push(directory)
    captureOutput()

    await run(['hooks', 'install', '--scope', 'project', '--project', directory])

    const settings = JSON.parse(
      await readFile(join(directory, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      readonly hooks: Readonly<Record<string, ReadonlyArray<unknown>>>
    }
    expect(Object.keys(settings.hooks)).toEqual(CLAUDEGRAM_HOOK_EVENTS)
  })

  it('forwards hook stdin to the configured Unix socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-cli-'))
    temporaryDirectories.push(directory)
    const socketPath = join(directory, 'daemon.sock')
    const registry = await Effect.runPromise(makeSessionRegistry)
    const ingress = await Effect.runPromise(
      startHookIngress(socketPath).pipe(
        Effect.provideService(SessionRegistry, registry),
      ),
    )
    vi.stubEnv('CLAUDEGRAM_CONFIG', join(directory, 'missing-config.json'))
    vi.stubEnv('CLAUDEGRAM_SOCKET_PATH', socketPath)
    vi.stubEnv('TMUX_PANE', '%42')
    const originalIterator = process.stdin[Symbol.asyncIterator]
    Object.defineProperty(process.stdin, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield JSON.stringify({
          session_id: 'cli-session',
          hook_event_name: 'SessionStart',
          cwd: '/work/project',
        })
      },
    })

    try {
      await run(['hook'])
      const session = await Effect.runPromise(registry.get('cli-session'))
      expect(Option.getOrThrow(session)).toMatchObject({
        id: 'cli-session',
        tmuxPane: '%42',
        cwd: '/work/project',
      })
    } finally {
      Object.defineProperty(process.stdin, Symbol.asyncIterator, {
        configurable: true,
        value: originalIterator,
      })
      await Effect.runPromise(ingress.close)
    }
  })
})

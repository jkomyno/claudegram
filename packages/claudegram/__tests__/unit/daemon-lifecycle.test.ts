import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ClaudegramConfig,
  cleanupInactiveTopics,
  controlInstalledService,
  daemonPaths,
  installService,
  makeSessionRegistry,
  restartDaemon,
  SessionRegistry,
  startDaemon,
  startHookIngress,
  stopDaemon,
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
  socketPath: join(directory, 'state', 'daemon.sock'),
  topicTtlHours: 72,
  verbose: false,
  configPath: join(directory, 'config.json'),
})

describe('daemon lifecycle', () => {
  it('recomputes the topic expiry cutoff on each cleanup cycle', async () => {
    const cutoffs: Array<number> = []
    const manager = {
      cleanupInactiveBefore: (cutoff: Date) =>
        Effect.sync(() => {
          cutoffs.push(cutoff.getTime())
          return []
        }),
    }
    const times = [100 * 60 * 60 * 1000, 110 * 60 * 60 * 1000]
    const cleanup = cleanupInactiveTopics(manager, 72, () => times.shift() ?? 0)

    await Effect.runPromise(cleanup)
    await Effect.runPromise(cleanup)

    expect(cutoffs).toEqual([28 * 60 * 60 * 1000, 38 * 60 * 60 * 1000])
  })

  it('does not signal a live unrelated process from a stale pid file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-lifecycle-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)
    const paths = daemonPaths(config)
    await mkdir(paths.stateDirectory, { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await once(child, 'spawn')
    if (child.pid === undefined) throw new Error('child process has no pid')
    await writeFile(paths.pidPath, `${child.pid}\n`)

    try {
      expect(
        await Effect.runPromise(
          stopDaemon(config, {
            service: { homeDirectory: directory, platform: 'darwin' },
          }),
        ),
      ).toEqual({ status: 'stopped', pid: child.pid })
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM')
      if (child.exitCode === null) await once(child, 'exit')
    }
  })

  it('launches once and reports only a ready daemon as started', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-lifecycle-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)
    const launches: Array<Readonly<Record<string, unknown>>> = []

    const state = await Effect.runPromise(
      startDaemon(config, {
        service: { homeDirectory: directory, platform: 'darwin' },
        launchDaemon: async (command) => {
          launches.push(command)
        },
        waitForState: async (_config, expected) => {
          expect(expected).toBe('running')
          return { status: 'running', pid: 12345 }
        },
      }),
    )

    expect(state).toEqual({ status: 'running', pid: 12345 })
    expect(launches).toMatchObject([
      { logPath: daemonPaths(config).logPath },
    ])
  })

  it('fails start when the launched daemon never becomes ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-lifecycle-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)

    await expect(
      Effect.runPromise(
        startDaemon(config, {
          service: { homeDirectory: directory, platform: 'darwin' },
          launchDaemon: async () => undefined,
          waitForState: async () => ({ status: 'starting', pid: 12345 }),
        }),
      ),
    ).rejects.toThrow('daemon did not become ready')
  })

  it('signals a verified daemon and removes only its matching identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-lifecycle-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)
    const paths = daemonPaths(config)
    await mkdir(paths.stateDirectory, { recursive: true })
    const token = 'verified-daemon'
    await writeFile(
      paths.pidPath,
      `${JSON.stringify({ pid: process.pid, token })}\n`,
    )
    const registry = await Effect.runPromise(makeSessionRegistry)
    const ingress = await Effect.runPromise(
      startHookIngress(config.socketPath, { identityToken: token }).pipe(
        Effect.provideService(SessionRegistry, registry),
      ),
    )
    const signals: Array<readonly [number, NodeJS.Signals]> = []

    try {
      expect(
        await Effect.runPromise(
          stopDaemon(config, {
            service: { homeDirectory: directory, platform: 'darwin' },
            signalProcess: (pid, signal) => {
              signals.push([pid, signal])
            },
            waitForState: async () => ({ status: 'stopped', pid: process.pid }),
          }),
        ),
      ).toEqual({ status: 'stopped', pid: process.pid })
      expect(signals).toEqual([[process.pid, 'SIGTERM']])
      await expect(readFile(paths.pidPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await Effect.runPromise(ingress.close)
    }
  })

  it('runs the unmanaged stop and start paths during restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-lifecycle-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)
    const paths = daemonPaths(config)
    await mkdir(paths.stateDirectory, { recursive: true })
    const token = 'restart-daemon'
    await writeFile(
      paths.pidPath,
      `${JSON.stringify({ pid: process.pid, token })}\n`,
    )
    const registry = await Effect.runPromise(makeSessionRegistry)
    const ingress = await Effect.runPromise(
      startHookIngress(config.socketPath, { identityToken: token }).pipe(
        Effect.provideService(SessionRegistry, registry),
      ),
    )
    const actions: Array<string> = []

    try {
      const state = await Effect.runPromise(
        restartDaemon(config, {
          service: { homeDirectory: directory, platform: 'darwin' },
          signalProcess: () => {
            actions.push('signal')
          },
          launchDaemon: async () => {
            actions.push('launch')
          },
          waitForState: async (_config, expected) => {
            actions.push(`wait:${expected}`)
            return expected === 'stopped'
              ? { status: 'stopped', pid: process.pid }
              : { status: 'running', pid: 67890 }
          },
        }),
      )

      expect(state).toEqual({ status: 'running', pid: 67890 })
      expect(actions).toEqual([
        'signal',
        'wait:stopped',
        'launch',
        'wait:running',
      ])
    } finally {
      await Effect.runPromise(ingress.close)
    }
  })

  it('uses launchd bootout, bootstrap, and kickstart for installed services', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-service-'))
    temporaryDirectories.push(directory)
    const config = makeConfig(directory)
    await Effect.runPromise(
      installService(config, {
        homeDirectory: directory,
        platform: 'darwin',
        invocationCommand: "'/opt/claudegram' daemon",
        executeCommands: false,
      }),
    )

    const stopCalls: Array<readonly [string, ReadonlyArray<string>]> = []
    await Effect.runPromise(
      controlInstalledService('stop', {
        homeDirectory: directory,
        platform: 'darwin',
        runCommand: async (executable, arguments_) => {
          stopCalls.push([executable, arguments_])
        },
      }),
    )
    expect(stopCalls.map(([, arguments_]) => arguments_[0])).toEqual([
      'print',
      'bootout',
    ])

    const startCalls: Array<readonly [string, ReadonlyArray<string>]> = []
    await Effect.runPromise(
      controlInstalledService('start', {
        homeDirectory: directory,
        platform: 'darwin',
        runCommand: async (executable, arguments_) => {
          startCalls.push([executable, arguments_])
          if (arguments_[0] === 'print') throw new Error('not loaded')
        },
      }),
    )
    expect(startCalls.map(([, arguments_]) => arguments_[0])).toEqual([
      'print',
      'bootstrap',
    ])

    const restartCalls: Array<readonly [string, ReadonlyArray<string>]> = []
    await Effect.runPromise(
      controlInstalledService('restart', {
        homeDirectory: directory,
        platform: 'darwin',
        runCommand: async (executable, arguments_) => {
          restartCalls.push([executable, arguments_])
        },
      }),
    )
    expect(restartCalls.map(([, arguments_]) => arguments_[0])).toEqual([
      'print',
      'kickstart',
    ])
  })
})

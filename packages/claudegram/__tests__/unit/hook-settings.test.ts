import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CLAUDEGRAM_HOOK_EVENTS,
  installHooks,
  uninstallHooks,
} from '../../src'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('hook settings', () => {
  it('installs idempotently and removes only managed handlers', async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), 'claudegram-hooks-'))
    temporaryDirectories.push(projectDirectory)
    const settingsDirectory = join(projectDirectory, '.claude')
    const settingsPath = join(settingsDirectory, 'settings.local.json')
    await mkdir(settingsDirectory)
    const existing = {
      permissions: { allow: ['Read'] },
      hooks: {
        Notification: [
          {
            matcher: '',
            hooks: [
              {
                type: 'prompt',
                prompt: 'Keep this unrelated prompt hook.',
              },
            ],
          },
        ],
      },
    }
    await writeFile(settingsPath, JSON.stringify(existing))
    const options = {
      scope: 'project' as const,
      projectDirectory,
      invocationCommand: "'/tmp/claudegram' hook",
    }

    const first = await Effect.runPromise(installHooks(options))
    const second = await Effect.runPromise(installHooks(options))
    const installed = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      readonly permissions: unknown
      readonly hooks: Readonly<Record<string, ReadonlyArray<unknown>>>
    }

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(Object.keys(installed.hooks).toSorted()).toEqual(
      [...CLAUDEGRAM_HOOK_EVENTS].toSorted(),
    )
    expect(installed.hooks.Notification).toHaveLength(2)
    expect(installed.hooks.PreToolUse).toMatchObject([
      { matcher: 'AskUserQuestion' },
    ])
    expect(installed.permissions).toEqual(existing.permissions)

    const removed = await Effect.runPromise(uninstallHooks(options))
    const uninstalled = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      readonly permissions: unknown
      readonly hooks: typeof existing.hooks
    }

    expect(removed.eventCount).toBe(CLAUDEGRAM_HOOK_EVENTS.length)
    expect(uninstalled).toEqual(existing)
  })
})

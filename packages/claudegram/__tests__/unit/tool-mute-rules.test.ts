import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import { makeToolMuteRules, parseHookEvent } from '../../src'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('tool mute rules', () => {
  it('matches allowed tools and scoped command patterns from Claude settings', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'claudegram-settings-'))
    temporaryDirectories.push(homeDirectory)
    await mkdir(join(homeDirectory, '.claude'))
    await writeFile(
      join(homeDirectory, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Read', 'Bash(pnpm test*)'],
        },
      }),
    )
    const rules = makeToolMuteRules({ homeDirectory })

    const readMuted = await Effect.runPromise(
      rules.isMuted(
        parseHookEvent({
          session_id: 's1',
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/README.md' },
        }),
      ),
    )
    const testMuted = await Effect.runPromise(
      rules.isMuted(
        parseHookEvent({
          session_id: 's1',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'pnpm test:unit' },
        }),
      ),
    )
    const statusMuted = await Effect.runPromise(
      rules.isMuted(
        parseHookEvent({
          session_id: 's1',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git status' },
        }),
      ),
    )

    expect(readMuted).toBe(true)
    expect(testMuted).toBe(true)
    expect(statusMuted).toBe(false)
  })
})

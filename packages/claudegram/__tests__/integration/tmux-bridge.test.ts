import { execFile } from 'node:child_process'

import * as Effect from 'effect/Effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeTmuxBridge, parseHookEvent, type Session } from '../../src'

const enabled = process.env.CLAUDEGRAM_TMUX_E2E === '1'
const socketName = `claudegram-test-${process.pid}`
const sessionName = 'bridge-test'
let pane = ''

const tmux = (...args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'tmux',
      ['-L', socketName, ...args],
      { encoding: 'utf8' },
      (cause, stdout) => {
        if (cause === null) {
          resolve(stdout)
        } else {
          reject(cause)
        }
      },
    )
  })

const waitForShell = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 150)
  })

describe.skipIf(!enabled)('tmux bridge e2e', () => {
  beforeAll(async () => {
    await tmux('new-session', '-d', '-s', sessionName)
    pane = (
      await tmux('display-message', '-p', '-t', sessionName, '#{pane_id}')
    ).trim()
  })

  afterAll(async () => {
    try {
      await tmux('kill-server')
    } catch {
      // The isolated server may already be gone after a failed assertion.
    }
  })

  it('submits literal text and interrupts the running command', async () => {
    const bridge = makeTmuxBridge({ socketName })
    const session: Session = {
      id: 'tmux-e2e',
      host: 'test-host',
      tmuxPane: pane,
      startedAt: '2026-08-13T12:00:00.000Z',
      lastActivityAt: '2026-08-13T12:00:00.000Z',
      lastEvent: parseHookEvent({
        session_id: 'tmux-e2e',
        hook_event_name: 'SessionStart',
      }),
    }

    await Effect.runPromise(
      bridge.sendText(session, "printf 'CLAUDEGRAM_TEXT_OK\\n'"),
    )
    await Effect.runPromise(bridge.sendText(session, 'sleep 30'))
    await waitForShell()
    await Effect.runPromise(bridge.interrupt(session))
    await Effect.runPromise(
      bridge.sendText(session, "printf 'CLAUDEGRAM_INTERRUPT_OK\\n'"),
    )
    await waitForShell()

    const output = await tmux('capture-pane', '-p', '-t', pane)
    expect(output).toContain('CLAUDEGRAM_TEXT_OK')
    expect(output).toContain('CLAUDEGRAM_INTERRUPT_OK')
  })
})

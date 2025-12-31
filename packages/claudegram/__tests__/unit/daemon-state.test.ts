import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DaemonStateError,
  loadDaemonSnapshot,
  makeHookEnvelope,
  makeSessionRegistry,
  parseHookEvent,
  restoreDaemonSnapshot,
  writeDaemonSnapshot,
} from '../../src'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('daemon state', () => {
  it('round-trips sessions and topics through the versioned snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-state-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state', 'daemon-state.json')
    const registry = await Effect.runPromise(makeSessionRegistry)
    const session = await Effect.runPromise(
      registry.record(
        makeHookEnvelope(
          parseHookEvent({
            session_id: 'session-1',
            hook_event_name: 'SessionStart',
            cwd: '/work/project',
          }),
          { host: 'host-1', tmuxPane: '%7' },
          new Date('2026-08-13T12:00:00.000Z'),
        ),
      ),
    )
    const snapshot = {
      sessions: [session],
      topics: [
        {
          sessionId: session.id,
          host: session.host,
          threadId: 101,
          name: 'host-1 · project',
          createdAt: '2026-08-13T12:00:01.000Z',
        },
      ],
    }

    await Effect.runPromise(writeDaemonSnapshot(path, snapshot))

    expect(await Effect.runPromise(loadDaemonSnapshot(path))).toEqual(snapshot)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('rejects malformed or structurally invalid snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claudegram-state-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'daemon-state.json')

    await writeFile(path, '{"version":1,"sessions":"invalid","topics":[]}')

    const error = await Effect.runPromise(
      loadDaemonSnapshot(path).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(DaemonStateError)
    expect(error.cause).toBeDefined()
  })

  it('restores only sessions whose tmux pane is still available', async () => {
    const registry = await Effect.runPromise(makeSessionRegistry)
    const makeSession = (id: string, tmuxPane: string) =>
      registry.record(
        makeHookEnvelope(
          parseHookEvent({
            session_id: id,
            hook_event_name: 'SessionStart',
          }),
          { host: 'host-1', tmuxPane },
          new Date('2026-08-13T12:00:00.000Z'),
        ),
      )
    const available = await Effect.runPromise(makeSession('available', '%7'))
    const stale = await Effect.runPromise(makeSession('stale', '%8'))
    const snapshot = {
      sessions: [available, stale],
      topics: [available, stale].map((session, index) => ({
        sessionId: session.id,
        host: session.host,
        threadId: 101 + index,
        name: session.id,
        createdAt: '2026-08-13T12:00:01.000Z',
      })),
    }

    const restored = await Effect.runPromise(
      restoreDaemonSnapshot(snapshot, {
        hasPane: (session) => Effect.succeed(session.tmuxPane === '%7'),
      }),
    )

    expect(restored.sessions.map((session) => session.id)).toEqual(['available'])
    expect(restored.topics.map((topic) => topic.sessionId)).toEqual(['available'])
  })
})

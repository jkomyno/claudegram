import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeHookEnvelope,
  makeSessionRegistry,
  parseHookEvent,
  sendHookEnvelope,
  SessionRegistry,
  startHookIngress,
} from '../../src'

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('hook ingress contract', () => {
  it('round-trips a hook fixture through the unix socket into the registry', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'claudegram-test-'))
    temporaryDirectories.push(temporaryDirectory)
    const socketPath = join(temporaryDirectory, 'daemon.sock')
    const fixturePath = fileURLToPath(
      new URL('../fixtures/hook-events/notification.json', import.meta.url),
    )
    const event = parseHookEvent(
      JSON.parse(await readFile(fixturePath, 'utf8')),
    )
    const registry = await Effect.runPromise(makeSessionRegistry)
    const registryLayer = Layer.succeed(SessionRegistry, registry)
    const ingress = await Effect.runPromise(
      startHookIngress(socketPath).pipe(Effect.provide(registryLayer)),
    )

    try {
      const acknowledgement = await Effect.runPromise(
        sendHookEnvelope(
          socketPath,
          makeHookEnvelope(
            event,
            { host: 'contract-host', tmuxPane: '%42' },
            new Date('2026-08-13T10:00:00.000Z'),
          ),
        ),
      )

      expect(acknowledgement.sessionId).toBe('session-contract-1')

      const session = Option.getOrThrow(
        await Effect.runPromise(registry.get('session-contract-1')),
      )
      expect(session).toMatchObject({
        id: 'session-contract-1',
        host: 'contract-host',
        tmuxPane: '%42',
        cwd: '/tmp/claudegram-contract',
        lastActivityAt: '2026-08-13T10:00:00.000Z',
        lastEvent: {
          hook_event_name: 'Notification',
          notification_type: 'idle_prompt',
        },
      })
    } finally {
      await Effect.runPromise(ingress.close)
    }
  })
})

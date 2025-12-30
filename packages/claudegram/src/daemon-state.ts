import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { isMissingFile } from './node-errors'
import { SessionSchema, type Session } from './session-registry'
import { SessionTopicSchema, type SessionTopic } from './topic-manager'

const DAEMON_STATE_VERSION = 1 as const

const DaemonSnapshotSchema = Schema.Struct({
  version: Schema.Literal(DAEMON_STATE_VERSION),
  sessions: Schema.Array(SessionSchema),
  topics: Schema.Array(SessionTopicSchema),
})

const DaemonSnapshotJsonSchema = Schema.parseJson(DaemonSnapshotSchema)

export interface DaemonSnapshot {
  readonly sessions: ReadonlyArray<Session>
  readonly topics: ReadonlyArray<SessionTopic>
}

export class DaemonStateError extends Data.TaggedError('DaemonStateError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const emptySnapshot: DaemonSnapshot = { sessions: [], topics: [] }

export const loadDaemonSnapshot = (
  path: string,
): Effect.Effect<DaemonSnapshot, DaemonStateError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const decoded = Schema.decodeUnknownSync(DaemonSnapshotJsonSchema)(
          await readFile(path, 'utf8'),
        )
        return { sessions: decoded.sessions, topics: decoded.topics }
      } catch (cause) {
        if (isMissingFile(cause)) return emptySnapshot
        throw cause
      }
    },
    catch: (cause) =>
      new DaemonStateError({ message: `failed to load daemon state from ${path}`, cause }),
  })

export const writeDaemonSnapshot = (
  path: string,
  snapshot: DaemonSnapshot,
): Effect.Effect<void, DaemonStateError> =>
  Effect.tryPromise({
    try: async () => {
      const temporaryPath = `${path}.${process.pid}.tmp`
      try {
        const encoded = Schema.encodeSync(DaemonSnapshotJsonSchema)({
          version: DAEMON_STATE_VERSION,
          sessions: snapshot.sessions,
          topics: snapshot.topics,
        })
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(temporaryPath, `${encoded}\n`, { mode: 0o600 })
        await rename(temporaryPath, path)
      } catch (cause) {
        await unlink(temporaryPath).catch((unlinkCause) => {
          if (!isMissingFile(unlinkCause)) throw unlinkCause
        })
        throw cause
      }
    },
    catch: (cause) =>
      new DaemonStateError({ message: `failed to persist daemon state to ${path}`, cause }),
  })

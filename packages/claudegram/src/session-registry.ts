import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'

import type { HookEnvelope, HookEvent } from './protocol'

export interface Session {
  readonly id: string
  readonly host: string
  readonly tmuxPane?: string
  readonly cwd?: string
  readonly transcriptPath?: string
  readonly startedAt: string
  readonly lastActivityAt: string
  readonly lastEvent: HookEvent
}

export interface SessionRegistryService {
  readonly record: (envelope: HookEnvelope) => Effect.Effect<Session>
  readonly get: (sessionId: string) => Effect.Effect<Option.Option<Session>>
  readonly list: Effect.Effect<ReadonlyArray<Session>>
  readonly remove: (sessionId: string) => Effect.Effect<boolean>
  readonly removeInactiveBefore: (cutoff: Date) => Effect.Effect<ReadonlyArray<Session>>
}

export class SessionRegistry extends Context.Tag('@claudegram/SessionRegistry')<
  SessionRegistry,
  SessionRegistryService
>() {}

const sessionFromEnvelope = (
  envelope: HookEnvelope,
  previous?: Session,
): Session => {
  const event = envelope.event
  const activityAt = envelope.sentAt
  const optionalFields = {
    ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
    ...(event.transcript_path === undefined
      ? {}
      : { transcriptPath: event.transcript_path }),
    ...(envelope.context.tmuxPane === undefined
      ? {}
      : { tmuxPane: envelope.context.tmuxPane }),
  }

  return {
    id: event.session_id,
    host: envelope.context.host,
    startedAt: previous?.startedAt ?? activityAt,
    lastActivityAt: activityAt,
    lastEvent: event,
    ...(previous?.cwd === undefined ? {} : { cwd: previous.cwd }),
    ...(previous?.transcriptPath === undefined
      ? {}
      : { transcriptPath: previous.transcriptPath }),
    ...(previous?.tmuxPane === undefined ? {} : { tmuxPane: previous.tmuxPane }),
    ...optionalFields,
  }
}

export const makeSessionRegistry = Effect.gen(function* () {
  const state = yield* Ref.make<ReadonlyMap<string, Session>>(new Map())

  return SessionRegistry.of({
    record: (envelope) =>
      Ref.modify(state, (sessions) => {
        const session = sessionFromEnvelope(
          envelope,
          sessions.get(envelope.event.session_id),
        )
        const next = new Map(sessions)
        next.set(session.id, session)
        return [session, next] as const
      }),
    get: (sessionId) =>
      Ref.get(state).pipe(
        Effect.map((sessions) => Option.fromNullable(sessions.get(sessionId))),
      ),
    list: Ref.get(state).pipe(
      Effect.map((sessions) => Array.from(sessions.values())),
    ),
    remove: (sessionId) =>
      Ref.modify(state, (sessions) => {
        if (!sessions.has(sessionId)) {
          return [false, sessions] as const
        }

        const next = new Map(sessions)
        next.delete(sessionId)
        return [true, next] as const
      }),
    removeInactiveBefore: (cutoff) =>
      Ref.modify(state, (sessions) => {
        const removed: Array<Session> = []
        const next = new Map(sessions)

        for (const session of sessions.values()) {
          if (new Date(session.lastActivityAt) < cutoff) {
            removed.push(session)
            next.delete(session.id)
          }
        }

        return [removed, next] as const
      }),
  })
})

export const SessionRegistryLive = Layer.effect(
  SessionRegistry,
  makeSessionRegistry,
)

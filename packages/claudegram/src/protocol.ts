import * as Data from 'effect/Data'

export const HOOK_PROTOCOL_VERSION = 1 as const

export interface HookEvent {
  readonly session_id: string
  readonly hook_event_name: string
  readonly cwd?: string
  readonly transcript_path?: string
  readonly [key: string]: unknown
}

export interface HookContext {
  readonly host: string
  readonly tmuxPane?: string
}

export interface HookEnvelope {
  readonly type: 'hook'
  readonly version: typeof HOOK_PROTOCOL_VERSION
  readonly sentAt: string
  readonly context: HookContext
  readonly event: HookEvent
}

export interface HookAcknowledgement {
  readonly type: 'ack'
  readonly version: typeof HOOK_PROTOCOL_VERSION
  readonly accepted: true
  readonly sessionId: string
}

export interface HookRejection {
  readonly type: 'error'
  readonly version: typeof HOOK_PROTOCOL_VERSION
  readonly accepted: false
  readonly message: string
}

export type HookResponse = HookAcknowledgement | HookRejection

export class HookProtocolError extends Data.TaggedError('HookProtocolError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireNonEmptyString = (
  value: unknown,
  field: string,
): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HookProtocolError({ message: `${field} must be a non-empty string` })
  }

  return value
}

export const parseHookEvent = (value: unknown): HookEvent => {
  if (!isRecord(value)) {
    throw new HookProtocolError({ message: 'hook event must be a JSON object' })
  }

  requireNonEmptyString(value.session_id, 'session_id')
  requireNonEmptyString(value.hook_event_name, 'hook_event_name')

  return value as HookEvent
}

export const makeHookEnvelope = (
  event: HookEvent,
  context: HookContext,
  sentAt = new Date(),
): HookEnvelope => ({
  type: 'hook',
  version: HOOK_PROTOCOL_VERSION,
  sentAt: sentAt.toISOString(),
  context,
  event,
})

export const parseHookEnvelope = (line: string): HookEnvelope => {
  let value: unknown

  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new HookProtocolError({ message: 'hook request is not valid JSON', cause })
  }

  if (!isRecord(value)) {
    throw new HookProtocolError({ message: 'hook request must be a JSON object' })
  }

  if (value.type !== 'hook' || value.version !== HOOK_PROTOCOL_VERSION) {
    throw new HookProtocolError({ message: 'unsupported hook protocol message' })
  }

  if (!isRecord(value.context)) {
    throw new HookProtocolError({ message: 'hook context must be a JSON object' })
  }

  const host = requireNonEmptyString(value.context.host, 'context.host')
  const tmuxPane = value.context.tmuxPane
  if (tmuxPane !== undefined && typeof tmuxPane !== 'string') {
    throw new HookProtocolError({ message: 'context.tmuxPane must be a string' })
  }

  return {
    type: 'hook',
    version: HOOK_PROTOCOL_VERSION,
    sentAt: requireNonEmptyString(value.sentAt, 'sentAt'),
    context: tmuxPane === undefined ? { host } : { host, tmuxPane },
    event: parseHookEvent(value.event),
  }
}

export const parseHookResponse = (line: string): HookResponse => {
  let value: unknown

  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new HookProtocolError({ message: 'hook response is not valid JSON', cause })
  }

  if (
    !isRecord(value) ||
    value.version !== HOOK_PROTOCOL_VERSION ||
    (value.type !== 'ack' && value.type !== 'error')
  ) {
    throw new HookProtocolError({ message: 'unsupported hook protocol response' })
  }

  if (value.type === 'ack') {
    if (value.accepted !== true) {
      throw new HookProtocolError({ message: 'hook acknowledgement was not accepted' })
    }

    return {
      type: 'ack',
      version: HOOK_PROTOCOL_VERSION,
      accepted: true,
      sessionId: requireNonEmptyString(value.sessionId, 'sessionId'),
    }
  }

  if (value.accepted !== false) {
    throw new HookProtocolError({ message: 'hook rejection has an invalid accepted value' })
  }

  return {
    type: 'error',
    version: HOOK_PROTOCOL_VERSION,
    accepted: false,
    message: requireNonEmptyString(value.message, 'message'),
  }
}

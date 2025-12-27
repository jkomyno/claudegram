import * as Data from 'effect/Data'
import * as Schema from 'effect/Schema'

export const HOOK_PROTOCOL_VERSION = 1 as const

const OpenRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})

export const HookEventSchema = Schema.asSchema(
  Schema.Struct({
    session_id: Schema.NonEmptyString,
    hook_event_name: Schema.NonEmptyString,
    cwd: Schema.optional(Schema.String),
    transcript_path: Schema.optional(Schema.String),
  }).pipe(Schema.extend(OpenRecord)),
)

export type HookEvent = typeof HookEventSchema.Type

export const HookContextSchema = Schema.Struct({
  host: Schema.NonEmptyString,
  tmuxPane: Schema.optional(Schema.String),
})

export type HookContext = typeof HookContextSchema.Type

export const HookEnvelopeSchema = Schema.Struct({
  type: Schema.Literal('hook'),
  version: Schema.Literal(HOOK_PROTOCOL_VERSION),
  sentAt: Schema.NonEmptyString,
  context: HookContextSchema,
  event: HookEventSchema,
})

export type HookEnvelope = typeof HookEnvelopeSchema.Type

export const HookAcknowledgementSchema = Schema.Struct({
  type: Schema.Literal('ack'),
  version: Schema.Literal(HOOK_PROTOCOL_VERSION),
  accepted: Schema.Literal(true),
  sessionId: Schema.NonEmptyString,
})

export type HookAcknowledgement = typeof HookAcknowledgementSchema.Type

export const HookRejectionSchema = Schema.Struct({
  type: Schema.Literal('error'),
  version: Schema.Literal(HOOK_PROTOCOL_VERSION),
  accepted: Schema.Literal(false),
  message: Schema.NonEmptyString,
})

export type HookRejection = typeof HookRejectionSchema.Type

export const HookResponseSchema = Schema.Union(
  HookAcknowledgementSchema,
  HookRejectionSchema,
)

export type HookResponse = typeof HookResponseSchema.Type

const HookEnvelopeJsonSchema = Schema.parseJson(HookEnvelopeSchema)
const HookResponseJsonSchema = Schema.parseJson(HookResponseSchema)

export class HookProtocolError extends Data.TaggedError('HookProtocolError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const decode = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
  message: string,
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(input)
  } catch (cause) {
    throw new HookProtocolError({ message, cause })
  }
}

const encode = <A, I>(
  schema: Schema.Schema<A, I>,
  value: A,
  message: string,
): I => {
  try {
    return Schema.encodeSync(schema)(value)
  } catch (cause) {
    throw new HookProtocolError({ message, cause })
  }
}

export const parseHookEvent = (value: unknown): HookEvent =>
  decode(HookEventSchema, value, 'invalid hook event')

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

export const parseHookEnvelope = (line: string): HookEnvelope =>
  decode(HookEnvelopeJsonSchema, line, 'invalid hook request')

export const encodeHookEnvelope = (envelope: HookEnvelope): string =>
  encode(HookEnvelopeJsonSchema, envelope, 'failed to encode hook request')

export const parseHookResponse = (line: string): HookResponse =>
  decode(HookResponseJsonSchema, line, 'invalid hook response')

export const encodeHookResponse = (response: HookResponse): string =>
  encode(HookResponseJsonSchema, response, 'failed to encode hook response')

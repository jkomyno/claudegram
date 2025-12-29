# Effect Schema boundaries

Use Schema as the source of truth for wire and persistence contracts.

## JSON contracts

- Define structures with `Schema.Struct`, discriminants with `Schema.Literal`, and alternatives with `Schema.Union`.
- Use `Schema.optional` only when absence is valid in the external contract.
- Infer TypeScript types with `typeof MySchema.Type`; do not maintain a second handwritten interface.
- Wrap JSON text with `Schema.parseJson(schema)` and use its decoder and encoder.
- Avoid `JSON.parse`, `as Record<string, unknown>`, and handwritten record checks at untrusted boundaries.

Use `packages/claudegram/src/protocol.ts` as the canonical request-response example. It defines hook events, context, envelopes, acknowledgements, and rejections as schemas and encodes or decodes JSON through `Schema.parseJson`.

## Open payloads

Claude hook events contain event-specific fields. Extend the known common fields with an open record only at that intentionally extensible boundary:

```ts
const OpenRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})

const HookLikeSchema = Schema.asSchema(
  Schema.Struct({
    session_id: Schema.NonEmptyString,
  }).pipe(Schema.extend(OpenRecord)),
)
```

Prefer closed structures for daemon responses, config written by claudegram, and Telegram response projections.

## Decoding choices

- Use `Schema.decodeUnknownSync` only when the surrounding API is synchronous and the caller translates parse failures.
- Use `Schema.decodeUnknownOption` for optional event projections where a non-match means “not this event,” not an operational failure.
- Preserve parse causes inside the relevant tagged domain error.
- Encode output with `Schema.encodeSync` instead of assuming a typed value is serializable.

For HTTP JSON, use `HttpClientResponse.schemaBodyJson` so status handling and body decoding remain in the Effect error channel.

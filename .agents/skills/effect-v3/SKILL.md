---
name: effect-v3
description: Implement, refactor, or review claudegram code using pinned Effect v3 APIs, including Effect programs, Context.Tag services, Layer composition, Data.TaggedError failures, Scope and finalizers, Effect Schema decoding, @effect/platform HTTP, and @effect/cli. Use whenever source imports effect, @effect/platform, @effect/platform-bun, or @effect/cli, or when replacing manual JSON and untyped async boundaries.
---

# Effect v3

Use only APIs compatible with claudegram's pinned `effect@3.19.13` stack. Do not import Effect v4 patterns.

Read the relevant reference before editing:

- `references/core-patterns.md` for services, errors, resources, composition, and Promise boundaries.
- `references/schema-boundaries.md` for JSON, hook payloads, Telegram responses, config, and other untrusted data.
- `references/platform-cli.md` for HTTP, Node or Bun integration, and Effect CLI commands.

## Workflow

1. Inspect the closest existing service and its tests before introducing a new pattern.
2. Model reusable work as `Effect.Effect<Success, Error, Requirements>` and keep dependencies visible.
3. Decode at system boundaries, preserve causes in typed errors, and provide services at composition roots.
4. Scope servers, processes, sockets, and signal handlers so cleanup is guaranteed.
5. Verify the narrow behavior first, then build and type-check the affected package.

Apply the `testing` skill when adding regression coverage or choosing verification commands.

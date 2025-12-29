---
name: typescript
description: Implement, refactor, or review TypeScript in claudegram, including package boundaries, public types, compiler configuration, exports, Node and Bun interoperability, and strictness failures. Use for changes to .ts files, tsconfig files, package exports, or shared monorepo contracts. Pair with effect-v3 for Effect services, schemas, errors, or runtimes, and with testing when behavior changes.
---

# TypeScript

Keep TypeScript changes aligned with claudegram's strict ESM monorepo and its two-package boundary.

Read `references/conventions.md` before changing source, compiler settings, package exports, or runtime boundaries.

## Workflow

1. Read the nearest source, package manifest, and existing tests before choosing an abstraction.
2. Keep bridge and daemon behavior in `packages/claudegram`; keep command parsing, terminal prompts, and runtime startup in `packages/cli`.
3. Decode untrusted input instead of asserting it. Preserve typed public contracts and explicit error channels.
4. Keep Promise-returning APIs at external boundaries. Expose Effect programs from core services when the surrounding code is Effect-based.
5. Add or update tests only for changed behavior or public contracts, then run the narrowest relevant checks.

Apply the `effect-v3` skill for Effect, Schema, Context, Layer, or platform code. Apply the `testing` skill when selecting or authoring verification.

# Repository Guidance

`AGENTS.md` is the canonical repo-wide AI guidance file.

## Commands

- Run `pnpm build` to build all packages via turbo.
- Run `pnpm test` for unit and integration tests (vitest workspace).
- Run `pnpm lint` for oxlint with autofix. Run `pnpm lint:ci` in check mode.
- Run `pnpm check:exports` for attw export checks.

## Local skills

- Read `.agents/skills/typescript/SKILL.md` before TypeScript, compiler, package-boundary, or export changes.
- Read `.agents/skills/testing/SKILL.md` before adding, changing, or debugging tests.
- Read `.agents/skills/effect-v3/SKILL.md` before changes using Effect, Effect Schema, `@effect/platform`, or `@effect/cli`.
- Apply every matching skill when a change crosses these areas.

## Layout

- `packages/claudegram` holds the core services and the daemon.
- `packages/cli` holds the Effect CLI and the wizard, and publishes the `claudegram` and `cgm` binaries.

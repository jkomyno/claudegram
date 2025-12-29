# Claudegram TypeScript conventions

## Package ownership

- Put protocol, config, Telegram, tmux, daemon, and domain services in `packages/claudegram`.
- Put command definitions, terminal prompts, and Bun runtime startup in `packages/cli`.
- Export public core contracts through `packages/claudegram/src/index.ts`.
- Preserve the `@claudegram/source` custom condition and package export maps when changing entrypoints.

## Type discipline

- Keep code compatible with `strict`, `isolatedModules`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax`.
- Use `import type` when an import is erased at runtime.
- Prefer readonly interfaces and discriminated unions for public state and responses.
- Treat external JSON, environment variables, files, HTTP bodies, and hook input as `unknown` until decoded.
- Avoid `any`, unchecked casts, non-null assertions, and parallel handwritten type guards when a schema owns the contract.
- Preserve the original cause when translating external failures into domain errors.

## Runtime boundaries

- Keep Promise-based APIs to the minimum required by Node callbacks, filesystem operations, test servers, and process startup.
- Wrap fallible async work in the surrounding Effect service instead of exposing Promise-returning core APIs.
- Use Bun-specific runtime code only in `packages/cli`; keep `packages/claudegram` usable from Node-compatible tests and builds.
- Avoid reading global process state deep inside domain logic when a config value or service can be passed explicitly.

## Dependencies and builds

- Keep ESM and CJS declarations aligned with the existing tsdown configs and package export maps.

## Focused verification

```sh
pnpm exec tsc -b tsconfig.src.json tsconfig.test.json --pretty false
pnpm lint:ci
pnpm build
pnpm check:exports
```

Use the `testing` skill to choose test scope.

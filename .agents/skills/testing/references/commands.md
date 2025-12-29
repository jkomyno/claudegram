# Test commands

Run commands from the repository root.

## One file

```sh
pnpm exec vitest --config ./vitest.config.ts --project unit run packages/claudegram/__tests__/unit/config.test.ts
pnpm exec vitest --config ./vitest.config.ts --project integration run packages/claudegram/__tests__/integration/hook-ingress.test.ts
```

## One project

```sh
pnpm test:unit
pnpm test:integration
```

Vitest 4 uses `test.projects` in `vitest.config.ts`. Do not restore `defineWorkspace`, `vitest.workspace.ts`, or the removed `--workspace` option.

## Real tmux boundary

```sh
CLAUDEGRAM_TMUX_E2E=1 pnpm test:integration
```

Use the opt-in test only when tmux is available. It creates an isolated tmux server and must clean it up.

## Final repository gates

```sh
pnpm test
pnpm lint:ci
pnpm build
pnpm check:exports
```

Run the full set for cross-cutting runtime, protocol, package, or toolchain changes. Ordinary focused changes need only the relevant subset.

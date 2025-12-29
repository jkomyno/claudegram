# Test patterns

## Placement

- Put isolated service behavior in `packages/*/__tests__/unit/**/*.test.ts`.
- Put Unix socket, HTTP, multi-service, or process-boundary behavior in `packages/*/__tests__/integration/**/*.test.ts`.
- Store reusable Claude hook payloads under `packages/claudegram/__tests__/fixtures/hook-events/`.

## Effect tests

- Run Effect programs with `Effect.runPromise` at the test boundary.
- Construct doubles with the service's `.of(...)` helper and provide them with `Effect.provideService`.
- Assert the domain result or tagged error, not private Ref state or generator steps.
- Keep time, process IDs, sockets, and external services injectable when deterministic behavior depends on them.

## External boundaries

- Bind fake HTTP servers to `127.0.0.1` on an ephemeral port.
- Record Telegram method names and decoded request bodies, then return schema-valid Bot API responses.
- Use unique temporary directories and Unix socket paths; remove them in `afterEach` or `afterAll`.
- Never use a real bot token, Telegram chat, Claude account, or user service in automated tests.
- Gate real tmux coverage with `CLAUDEGRAM_TMUX_E2E=1`, use an isolated tmux socket name, and kill the test server during cleanup.

## Coverage choices

Add or modify tests for:

- changed behavior;
- a bug regression;
- a previously untested public contract;
- boundary decoding, routing, cleanup, or error behavior that could silently misdirect a session.

Do not add tests solely for coverage numbers, unchanged behavior, trivial exports, generated output, or implementation details.

When a normal run skips the tmux test, report the skip separately. Only the opt-in run proves literal text submission and Ctrl+C behavior.

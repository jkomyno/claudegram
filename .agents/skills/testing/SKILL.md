---
name: testing
description: Select, write, debug, and run claudegram TypeScript tests with Vitest 4, fake Telegram HTTP servers, Unix sockets, and opt-in real tmux coverage. Use when behavior changes, a regression needs protection, tests or CI fail, test placement is unclear, or verification scope must be chosen. Do not add tests for unchanged behavior, trivial wiring, or generated output.
---

# Testing

Use the smallest test that proves the changed contract, then widen verification in proportion to risk.

Read the relevant reference:

- `references/commands.md` before choosing commands or running broad gates.
- `references/patterns.md` before adding or restructuring tests.

## Workflow

1. Identify the observable behavior and the boundary where it can fail.
2. Prefer a unit test for one service and an integration test for protocol, HTTP, socket, or tmux boundaries.
3. Reuse local fakes and fixtures. Never send real Telegram traffic from automated tests.
4. Run the focused file or project first. Run the full suite only for cross-cutting changes or final verification.
5. Report skipped opt-in checks explicitly; do not count them as passing.

Apply the `effect-v3` skill when tests construct Effect services, provide layers, or assert typed failures.

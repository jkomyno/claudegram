# Effect platform and CLI

## HTTP

- Obtain `HttpClient.HttpClient` from the environment.
- Build requests with `@effect/platform/HttpClientRequest`.
- Decode JSON responses with `HttpClientResponse.schemaBodyJson` and an Effect Schema.
- Map transport, status, and decode failures into a domain error that names the attempted operation.
- Keep Telegram's base URL injectable for local fake-server tests.

Use `packages/claudegram/src/telegram-api.ts` as the local pattern.

## Node and Bun

- Keep Bun runtime assembly in `packages/cli/src/bin.ts`.
- Provide `BunContext.layer` and `FetchHttpClient.layer` at the CLI entrypoint.
- Keep the core package independent of Bun-only globals so Vitest and Node-compatible consumers can load it.
- Adapt Node callbacks with `Effect.async` or `Effect.tryPromise` when an Effect Platform service is not a practical fit.
- Pair acquired sockets, servers, file handles, and signal listeners with release actions.

## Effect CLI

- Define commands with `Command.make`, typed `Options`, concise descriptions, and Effect handlers.
- Load configuration inside the handler and provide runtime layers at the outer command or process boundary.
- Keep stdout machine-readable when `--json` is selected; send failures through the Effect error channel for centralized rendering.
- Never accept the Telegram bot token as a command-line flag.
- Keep `hook` and `daemon` as internal entrypoints even though they share the compiled binary.

Use `packages/cli/src/commands.ts` for command composition and `packages/cli/src/bin.ts` for runtime assembly and final error rendering.

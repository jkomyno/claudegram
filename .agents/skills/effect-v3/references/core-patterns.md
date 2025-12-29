# Effect v3 core patterns

## Version contract

Claudegram pins `effect@3.19.13`, `@effect/platform@0.94.0`, `@effect/cli@0.73.0`, and `@effect/platform-bun@0.87.0`. Confirm exact versions in package manifests before using an unfamiliar API. Do not infer APIs from Effect v4 examples.

Follow the repository's namespace import style:

```ts
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
```

## Services and layers

- Define a small service interface around domain capability, not a broad utility collection.
- Declare services with `Context.Tag` and construct values with `Tag.of(...)`.
- Build live implementations with `Effect.gen`; expose a `Layer` when composition benefits from it.
- Keep required services visible in the `R` parameter until the daemon or CLI composition root provides them.
- Inject test doubles with `Effect.provideService` rather than patching globals.

Use existing services as local references:

- `packages/claudegram/src/telegram-api.ts` for an HTTP-backed service.
- `packages/claudegram/src/session-registry.ts` for Ref-backed state.
- `packages/claudegram/src/topic-manager.ts` for coordinated state and dependencies.

## Errors

- Model expected failures with `Data.TaggedError` and retain the original `cause` when available.
- Use `Effect.try` and `Effect.tryPromise` at fallible synchronous and Promise boundaries.
- Translate infrastructure errors once, near the boundary; do not repeatedly erase useful error types.
- Do not use defects for ordinary invalid input, unavailable services, or network failures.
- Use `Effect.catchAll` or `Effect.ignore` only when the behavior explicitly tolerates the failure.

## Resources and concurrency

- Use `Effect.scoped` with `Effect.acquireRelease` for pid files, sockets, servers, and other owned resources.
- Use `Effect.forkScoped` for background polling and cleanup fibers that must stop with the daemon scope.
- Register signal handlers with an Effect finalizer so interruption removes them.
- Avoid detached or untracked fibers inside reusable services.

## Promise boundary

- Return Effect values from core capabilities.
- Use Promise callbacks only to adapt Node or third-party APIs that do not already expose Effect integrations.
- Call `Effect.runPromise` only at process entrypoints, test boundaries, or unavoidable callback bridges; prefer composition within Effect elsewhere.

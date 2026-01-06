import { Command } from '@effect/platform'
import { BunContext, BunRuntime } from '@effect/platform-bun'
import * as Effect from 'effect/Effect'

export const buildBinary = Effect.gen(function* () {
  const args = [
    'bun',
    'build',
    './src/bin.ts',
    '--compile',
    '--production',
    '--outfile',
    './build/claudegram',
  ] as const satisfies ReadonlyArray<string>

  const exitCode = yield* Command.make(...args).pipe(
    Command.stdout('inherit'),
    Command.stderr('inherit'),
    Command.exitCode,
  )

  if (exitCode !== 0) {
    return yield* Effect.fail(
      new Error(`Failed to build claudegram binary (exit code ${exitCode})`),
    )
  }
})

buildBinary.pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)

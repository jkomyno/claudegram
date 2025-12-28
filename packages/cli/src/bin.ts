import { HelpDoc, ValidationError } from '@effect/cli'
import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import { BunContext, BunRuntime } from '@effect/platform-bun'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { runCli } from './commands'

const runtime = Layer.mergeAll(BunContext.layer, FetchHttpClient.layer)

runCli(process.argv).pipe(
  Effect.provide(runtime),
  Effect.catchAll((cause) =>
    Effect.sync(() => {
      const message = ValidationError.isValidationError(cause)
        ? HelpDoc.toAnsiText(cause.error).trim()
        : cause instanceof Error
          ? cause.message
          : String(cause)
      process.stderr.write(`claudegram: ${message}\n`)
      process.exitCode = 1
    }),
  ),
  BunRuntime.runMain,
)

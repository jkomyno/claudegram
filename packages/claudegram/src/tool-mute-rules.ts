import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { HookEvent } from './protocol'

const ToolEventSchema = Schema.Struct({
  tool_name: Schema.NonEmptyString,
  tool_input: Schema.optional(Schema.Unknown),
})

const ClaudeSettingsSchema = Schema.Struct({
  permissions: Schema.optional(
    Schema.Struct({
      allow: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

const ClaudeSettingsJsonSchema = Schema.parseJson(ClaudeSettingsSchema)

export interface ToolMuteRulesService {
  readonly isMuted: (event: HookEvent) => Effect.Effect<boolean>
}

export class ToolMuteRules extends Context.Tag('@claudegram/ToolMuteRules')<
  ToolMuteRules,
  ToolMuteRulesService
>() {}

const readAllowedRules = async (path: string): Promise<ReadonlyArray<string>> => {
  try {
    const settings = Schema.decodeUnknownSync(ClaudeSettingsJsonSchema)(
      await readFile(path, 'utf8'),
    )
    return settings.permissions?.allow ?? []
  } catch {
    return []
  }
}

const inputCandidate = (toolName: string, input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined
  }

  const record = input as Readonly<Record<string, unknown>>
  const field =
    toolName === 'Bash'
      ? record.command
      : toolName === 'WebFetch'
        ? record.url
        : toolName === 'WebSearch'
          ? record.query
          : record.file_path

  return typeof field === 'string' ? field : undefined
}

const escapeRegularExpression = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

const matchesRule = (
  rule: string,
  toolName: string,
  input: unknown,
): boolean => {
  if (rule === toolName) {
    return true
  }

  const prefix = `${toolName}(`
  if (!rule.startsWith(prefix) || !rule.endsWith(')')) {
    return false
  }

  const candidate = inputCandidate(toolName, input)
  if (candidate === undefined) {
    return false
  }

  const pattern = rule.slice(prefix.length, -1)
  const expression = new RegExp(
    `^${pattern.split('*').map(escapeRegularExpression).join('.*')}$`,
    'u',
  )
  return expression.test(candidate)
}

export interface ToolMuteRulesOptions {
  readonly homeDirectory?: string
}

export const makeToolMuteRules = (
  options: ToolMuteRulesOptions = {},
): ToolMuteRulesService => ({
  isMuted: (event) =>
    Effect.promise(async () => {
      const decoded = Schema.decodeUnknownOption(ToolEventSchema)(event)
      if (Option.isNone(decoded)) {
        return false
      }

      const paths = [
        join(options.homeDirectory ?? homedir(), '.claude', 'settings.json'),
        ...(event.cwd === undefined
          ? []
          : [
              join(event.cwd, '.claude', 'settings.json'),
              join(event.cwd, '.claude', 'settings.local.json'),
            ]),
      ]
      const rules = (await Promise.all(paths.map(readAllowedRules))).flat()
      return rules.some((rule) =>
        matchesRule(rule, decoded.value.tool_name, decoded.value.tool_input),
      )
    }),
})

export const ToolMuteRulesLive = Layer.succeed(
  ToolMuteRules,
  makeToolMuteRules(),
)

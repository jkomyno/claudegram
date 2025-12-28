import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const MANAGED_COMMAND_PREFIX = 'CLAUDEGRAM_MANAGED_HOOK=1 '

export const CLAUDEGRAM_HOOK_EVENTS = [
  'SessionStart',
  'Notification',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'Stop',
  'SubagentStop',
] as const

export type HookScope = 'global' | 'project'

const OpenRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

const HookHandlerSchema = OpenRecord

const HookGroupSchema = Schema.asSchema(
  Schema.Struct({
    matcher: Schema.optional(Schema.String),
    hooks: Schema.Array(HookHandlerSchema),
  }).pipe(Schema.extend(OpenRecord)),
)

const HooksSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Array(HookGroupSchema),
})

const ClaudeSettingsSchema = Schema.asSchema(
  Schema.Struct({
    hooks: Schema.optional(HooksSchema),
  }).pipe(Schema.extend(OpenRecord)),
)

const ClaudeSettingsJsonSchema = Schema.parseJson(ClaudeSettingsSchema, {
  space: 2,
})

type ClaudeSettings = typeof ClaudeSettingsSchema.Type
type HookGroup = typeof HookGroupSchema.Type

export class HookSettingsError extends Data.TaggedError('HookSettingsError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface HookSettingsOptions {
  readonly scope: HookScope
  readonly projectDirectory?: string
  readonly homeDirectory?: string
  readonly invocationCommand?: string
}

export interface HookSettingsResult {
  readonly settingsPath: string
  readonly changed: boolean
  readonly eventCount: number
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`

export const currentHookInvocation = (): string => {
  const script = process.argv[1]
  if (
    script !== undefined &&
    ['.js', '.mjs', '.cjs', '.ts'].some((extension) =>
      script.endsWith(extension),
    )
  ) {
    return `${shellQuote(process.execPath)} ${shellQuote(resolve(script))} hook`
  }

  return `${shellQuote(process.execPath)} hook`
}

export const hookSettingsPath = (options: HookSettingsOptions): string =>
  options.scope === 'global'
    ? join(options.homeDirectory ?? homedir(), '.claude', 'settings.json')
    : join(
        resolve(options.projectDirectory ?? process.cwd()),
        '.claude',
        'settings.local.json',
      )

const readSettings = async (path: string): Promise<ClaudeSettings> => {
  try {
    return Schema.decodeUnknownSync(ClaudeSettingsJsonSchema)(
      await readFile(path, 'utf8'),
    )
  } catch (cause) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 'ENOENT'
    ) {
      return {}
    }
    throw cause
  }
}

const writeSettings = async (
  path: string,
  settings: ClaudeSettings,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  const encoded = Schema.encodeSync(ClaudeSettingsJsonSchema)(settings)
  await writeFile(temporaryPath, `${encoded}\n`, { mode: 0o600 })
  await rename(temporaryPath, path)
}

const isManagedHook = (hook: typeof HookHandlerSchema.Type): boolean =>
  typeof hook.command === 'string' &&
  hook.command.startsWith(MANAGED_COMMAND_PREFIX)

const removeManagedHooks = (
  groups: ReadonlyArray<HookGroup>,
): ReadonlyArray<HookGroup> =>
  groups.flatMap((group) => {
    const hooks = group.hooks.filter((hook) => !isManagedHook(hook))
    return hooks.length === 0 ? [] : [{ ...group, hooks }]
  })

const normalizedJson = (value: unknown): string => JSON.stringify(value)

export const installHooks = (
  options: HookSettingsOptions,
): Effect.Effect<HookSettingsResult, HookSettingsError> =>
  Effect.tryPromise({
    try: async () => {
      const settingsPath = hookSettingsPath(options)
      const settings = await readSettings(settingsPath)
      const hooks = { ...settings.hooks }
      const command = `${MANAGED_COMMAND_PREFIX}${
        options.invocationCommand ?? currentHookInvocation()
      }`
      for (const event of CLAUDEGRAM_HOOK_EVENTS) {
        const managedGroup: HookGroup = {
          matcher: event === 'PreToolUse' ? 'AskUserQuestion' : '',
          hooks: [{ type: 'command', command, timeout: 10 }],
        }
        hooks[event] = [...removeManagedHooks(hooks[event] ?? []), managedGroup]
      }

      const next: ClaudeSettings = { ...settings, hooks }
      const changed = normalizedJson(next) !== normalizedJson(settings)
      if (changed) {
        await writeSettings(settingsPath, next)
      }

      return {
        settingsPath,
        changed,
        eventCount: CLAUDEGRAM_HOOK_EVENTS.length,
      }
    },
    catch: (cause) =>
      new HookSettingsError({ message: 'failed to install Claude Code hooks', cause }),
  })

export const uninstallHooks = (
  options: HookSettingsOptions,
): Effect.Effect<HookSettingsResult, HookSettingsError> =>
  Effect.tryPromise({
    try: async () => {
      const settingsPath = hookSettingsPath(options)
      const settings = await readSettings(settingsPath)
      const hooks = { ...settings.hooks }
      let removed = 0

      for (const [event, groups] of Object.entries(hooks)) {
        const nextGroups = removeManagedHooks(groups)
        removed += groups.reduce(
          (count, group) =>
            count + group.hooks.filter(isManagedHook).length,
          0,
        )
        if (nextGroups.length === 0) {
          delete hooks[event]
        } else {
          hooks[event] = nextGroups
        }
      }

      const next: ClaudeSettings =
        Object.keys(hooks).length === 0
          ? Object.fromEntries(
              Object.entries(settings).filter(([key]) => key !== 'hooks'),
            )
          : { ...settings, hooks }
      if (removed > 0) {
        await writeSettings(settingsPath, next)
      }

      return {
        settingsPath,
        changed: removed > 0,
        eventCount: removed,
      }
    },
    catch: (cause) =>
      new HookSettingsError({ message: 'failed to uninstall Claude Code hooks', cause }),
  })

export const inspectHooks = (
  options: HookSettingsOptions,
): Effect.Effect<HookSettingsResult, HookSettingsError> =>
  Effect.tryPromise({
    try: async () => {
      const settingsPath = hookSettingsPath(options)
      const settings = await readSettings(settingsPath)
      const eventCount = CLAUDEGRAM_HOOK_EVENTS.filter((event) =>
        (settings.hooks?.[event] ?? []).some((group) =>
          group.hooks.some(isManagedHook),
        ),
      ).length
      return {
        settingsPath,
        changed: false,
        eventCount,
      }
    },
    catch: (cause) =>
      new HookSettingsError({ message: 'failed to inspect Claude Code hooks', cause }),
  })

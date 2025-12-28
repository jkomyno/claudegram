import { hostname } from 'node:os'

import { Command, Options } from '@effect/cli'
import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import {
  CLAUDEGRAM_HOOK_EVENTS,
  daemonPaths,
  inspectDaemon,
  inspectHooks,
  inspectService,
  installHooks,
  installService,
  loadConfig,
  makeHookEnvelope,
  parseHookEventJson,
  readDaemonLogs,
  runDaemon,
  runDoctor,
  runSetupWizard,
  sendHookEnvelope,
  startDaemon,
  stopDaemon,
  uninstallHooks,
  uninstallService,
} from '@claudegram/core'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { CLI_NAME, CLI_VERSION } from './constants'
import { terminalWizardPrompt } from './prompt'

const print = (value: string): Effect.Effect<void> =>
  Effect.sync(() => process.stdout.write(`${value}\n`))

const printJson = (value: unknown): Effect.Effect<void> =>
  print(JSON.stringify(value, null, 2))

const readStandardInput = Effect.promise(async () => {
  process.stdin.setEncoding('utf8')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  return input
})

const jsonOption = Options.boolean('json').pipe(
  Options.withDefault(false),
  Options.withDescription('Print structured JSON output'),
)

const hookCommand = Command.make('hook').pipe(
  Command.withDescription('Forward one Claude Code hook event to the daemon.'),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig()
      const event = parseHookEventJson(yield* readStandardInput)
      yield* sendHookEnvelope(
        config.socketPath,
        makeHookEnvelope(event, {
          host: hostname(),
          ...(process.env.TMUX_PANE === undefined
            ? {}
            : { tmuxPane: process.env.TMUX_PANE }),
        }),
      )
    }),
  ),
)

const noInputOption = Options.boolean('no-input').pipe(
  Options.withDefault(false),
  Options.withDescription('Disable prompts and use the existing config'),
)

const setupCommand = Command.make(
  'setup',
  { noInput: noInputOption },
  ({ noInput }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig()
      if (noInput) {
        if (config.botToken === undefined || config.chatId === undefined) {
          return yield* Effect.fail(
            new Error('--no-input requires a bot token and chat id in env or config.'),
          )
        }
        const hooks = yield* installHooks({ scope: 'global' })
        const daemon = yield* startDaemon(config)
        yield* printJson({ configPath: config.configPath, hooks, daemon })
        return
      }

      const result = yield* runSetupWizard({
        prompt: terminalWizardPrompt,
        baseConfig: config,
      })
      yield* print(
        `Setup complete. Config: ${result.configPath}. Daemon: ${result.daemon?.status ?? 'not started'}.`,
      )
    }).pipe(Effect.provide(FetchHttpClient.layer)),
).pipe(Command.withDescription('Configure Telegram, hooks, and the daemon.'))

const startCommand = Command.make('start').pipe(
  Command.withDescription('Start the daemon in the background.'),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const state = yield* startDaemon(yield* loadConfig())
      yield* print(`Daemon ${state.status}${'pid' in state ? ` (pid ${state.pid})` : ''}.`)
    }),
  ),
)

const stopCommand = Command.make('stop').pipe(
  Command.withDescription('Stop the background daemon.'),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const state = yield* stopDaemon(yield* loadConfig())
      yield* print(`Daemon ${state.status}.`)
    }),
  ),
)

const restartCommand = Command.make('restart').pipe(
  Command.withDescription('Stop and start the daemon.'),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig()
      yield* stopDaemon(config)
      const state = yield* startDaemon(config)
      yield* print(`Daemon ${state.status}${'pid' in state ? ` (pid ${state.pid})` : ''}.`)
    }),
  ),
)

const statusCommand = Command.make(
  'status',
  { json: jsonOption },
  ({ json }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig()
      const state = yield* inspectDaemon(config)
      if (json) {
        yield* printJson({ ...state, ...daemonPaths(config) })
      } else {
        yield* print(`Daemon ${state.status}${'pid' in state ? ` (pid ${state.pid})` : ''}.`)
      }
    }),
).pipe(Command.withDescription('Report the daemon and socket state.'))

const linesOption = Options.integer('lines').pipe(
  Options.withDefault(100),
  Options.withDescription('Number of log lines to print'),
)

const logsCommand = Command.make(
  'logs',
  { lines: linesOption },
  ({ lines }) =>
    Effect.gen(function* () {
      const logs = yield* readDaemonLogs(yield* loadConfig(), lines)
      if (logs.length > 0) yield* print(logs)
    }),
).pipe(Command.withDescription('Print recent daemon logs.'))

const daemonCommand = Command.make('daemon').pipe(
  Command.withDescription('Run the daemon in the foreground.'),
  Command.withHandler(() =>
    loadConfig().pipe(
      Effect.flatMap(runDaemon),
      Effect.provide(FetchHttpClient.layer),
    ),
  ),
)

const scopeOption = Options.choice('scope', ['global', 'project'] as const).pipe(
  Options.withDefault('global'),
  Options.withDescription('Hook scope: global or project'),
)
const projectOption = Options.text('project').pipe(
  Options.optional,
  Options.withDescription('Project directory for project-scoped hooks'),
)

const hookOptions = { scope: scopeOption, project: projectOption }
const hookSettingsOptions = (
  scope: 'global' | 'project',
  project: Option.Option<string>,
) => ({
  scope,
  ...(Option.isNone(project) ? {} : { projectDirectory: project.value }),
})

const hooksInstallCommand = Command.make(
  'install',
  hookOptions,
  ({ scope, project }) =>
    installHooks(hookSettingsOptions(scope, project)).pipe(
      Effect.flatMap((result) =>
        print(
          `${result.changed ? 'Installed' : 'Already installed'} ${result.eventCount} hook events in ${result.settingsPath}.`,
        ),
      ),
    ),
).pipe(Command.withDescription('Install managed Claude Code hooks.'))

const hooksUninstallCommand = Command.make(
  'uninstall',
  hookOptions,
  ({ scope, project }) =>
    uninstallHooks(hookSettingsOptions(scope, project)).pipe(
      Effect.flatMap((result) =>
        print(
          `${result.changed ? 'Removed' : 'Found no'} managed hooks in ${result.settingsPath}.`,
        ),
      ),
    ),
).pipe(Command.withDescription('Remove only managed claudegram hooks.'))

const hooksStatusCommand = Command.make(
  'status',
  hookOptions,
  ({ scope, project }) =>
    inspectHooks(hookSettingsOptions(scope, project)).pipe(
      Effect.flatMap((result) =>
        print(
          `${result.eventCount}/${CLAUDEGRAM_HOOK_EVENTS.length} hook events installed in ${result.settingsPath}.`,
        ),
      ),
    ),
).pipe(Command.withDescription('Inspect managed Claude Code hooks.'))

const hooksCommand = Command.make('hooks').pipe(
  Command.withDescription('Manage Claude Code hook entries.'),
  Command.withSubcommands([
    hooksInstallCommand,
    hooksUninstallCommand,
    hooksStatusCommand,
  ]),
)

const serviceInstallCommand = Command.make('install').pipe(
  Command.withDescription('Install and activate the user auto-start service.'),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const result = yield* installService(yield* loadConfig())
      yield* print(`Installed ${result.platform} service at ${result.servicePath}.`)
    }),
  ),
)

const serviceUninstallCommand = Command.make('uninstall').pipe(
  Command.withDescription('Deactivate and remove the user auto-start service.'),
  Command.withHandler(() =>
    uninstallService().pipe(
      Effect.flatMap((result) => print(`Removed service ${result.servicePath}.`)),
    ),
  ),
)

const serviceStatusCommand = Command.make('status').pipe(
  Command.withDescription('Report whether the auto-start service is installed.'),
  Command.withHandler(() =>
    inspectService().pipe(
      Effect.flatMap((result) =>
        print(`Service ${result.installed ? 'installed' : 'not installed'} at ${result.servicePath}.`),
      ),
    ),
  ),
)

const serviceCommand = Command.make('service').pipe(
  Command.withDescription('Manage launchd or systemd auto-start.'),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceUninstallCommand,
    serviceStatusCommand,
  ]),
)

const doctorCommand = Command.make(
  'doctor',
  { json: jsonOption },
  ({ json }) =>
    Effect.gen(function* () {
      const report = yield* runDoctor({ config: yield* loadConfig() })
      if (json) {
        yield* printJson(report)
      } else {
        for (const check of report.checks) {
          yield* print(`${check.status.toUpperCase()} ${check.name}: ${check.message}`)
        }
      }
      if (!report.healthy) process.exitCode = 1
    }),
).pipe(Command.withDescription('Check config, daemon, hooks, and tmux.'))

const versionCommand = Command.make('version').pipe(
  Command.withDescription('Print the installed version.'),
  Command.withHandler(() => print(CLI_VERSION)),
)

const rootCommand = Command.make(CLI_NAME).pipe(
  Command.withDescription('Bridge Claude Code sessions and Telegram topics.'),
  Command.withSubcommands([
    setupCommand,
    startCommand,
    stopCommand,
    restartCommand,
    statusCommand,
    logsCommand,
    hooksCommand,
    serviceCommand,
    doctorCommand,
    versionCommand,
    hookCommand,
    daemonCommand,
  ]),
)

export const runCli = Command.run(rootCommand, {
  name: CLI_NAME,
  executable: CLI_NAME,
  version: CLI_VERSION,
})

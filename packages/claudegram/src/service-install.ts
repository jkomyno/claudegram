import { execFile } from 'node:child_process'
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

import type { ClaudegramConfig } from './config'
import { currentHookInvocation } from './hook-settings'

const SERVICE_NAME = 'dev.jkomyno.claudegram'

export type ServicePlatform = 'darwin' | 'linux'

export interface ServiceInstallOptions {
  readonly homeDirectory?: string
  readonly platform?: NodeJS.Platform
  readonly invocationCommand?: string
  readonly executeCommands?: boolean
  readonly runCommand?: (
    executable: string,
    arguments_: ReadonlyArray<string>,
  ) => Promise<void>
}

export type ServiceAction = 'start' | 'stop' | 'restart'

export interface ServiceResult {
  readonly servicePath: string
  readonly installed: boolean
  readonly platform: ServicePlatform
}

export class ServiceInstallError extends Data.TaggedError(
  'ServiceInstallError',
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const detectPlatform = (
  value: NodeJS.Platform,
): Effect.Effect<ServicePlatform, ServiceInstallError> =>
  value === 'darwin' || value === 'linux'
    ? Effect.succeed(value)
    : Effect.fail(
        new ServiceInstallError({
          message: `auto-start services are unsupported on ${value}`,
        }),
      )

const servicePathFor = (
  servicePlatform: ServicePlatform,
  homeDirectory: string,
): string =>
  servicePlatform === 'darwin'
    ? join(homeDirectory, 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`)
    : join(
        process.env.XDG_CONFIG_HOME ?? join(homeDirectory, '.config'),
        'systemd',
        'user',
        'claudegram.service',
      )

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const launchdDefinition = (
  invocationCommand: string,
  logPath: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${escapeXml(invocationCommand)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`

const systemdEscape = (value: string): string => value.replaceAll('%', '%%')

const systemdDefinition = (invocationCommand: string): string => `[Unit]
Description=claudegram Telegram bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh -lc '${systemdEscape(invocationCommand.replaceAll("'", `'\\''`))}'
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`

const runCommand = (
  executable: string,
  arguments_: ReadonlyArray<string>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(executable, arguments_, (cause) => {
      if (cause === null) resolve()
      else reject(cause)
    })
  })

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const writeAtomic = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, content, { mode: 0o600 })
  await rename(temporaryPath, path)
}

const invocationForDaemon = (override?: string): string =>
  override ?? currentHookInvocation().replace(/ hook$/u, ' daemon')

const commandSucceeds = async (
  command: ServiceInstallOptions['runCommand'],
  executable: string,
  arguments_: ReadonlyArray<string>,
): Promise<boolean> => {
  try {
    await (command ?? runCommand)(executable, arguments_)
    return true
  } catch {
    return false
  }
}

const runServiceAction = async (
  action: ServiceAction,
  servicePlatform: ServicePlatform,
  servicePath: string,
  command: ServiceInstallOptions['runCommand'],
): Promise<void> => {
  const execute = command ?? runCommand
  if (servicePlatform === 'linux') {
    await execute('systemctl', ['--user', action, 'claudegram.service'])
    return
  }

  const domain = `gui/${process.getuid?.() ?? 0}`
  const target = `${domain}/${SERVICE_NAME}`
  if (action === 'stop') {
    const loaded = await commandSucceeds(command, 'launchctl', [
      'print',
      target,
    ])
    if (!loaded) return
    await execute('launchctl', ['bootout', domain, servicePath])
    return
  }

  const loaded = await commandSucceeds(command, 'launchctl', [
    'print',
    target,
  ])
  if (!loaded) {
    await execute('launchctl', ['bootstrap', domain, servicePath])
    return
  }

  await execute('launchctl', ['kickstart', '-k', target])
}

export const controlInstalledService = (
  action: ServiceAction,
  options: ServiceInstallOptions = {},
): Effect.Effect<boolean, ServiceInstallError> =>
  Effect.gen(function* () {
    const servicePlatform = yield* detectPlatform(options.platform ?? platform())
    const servicePath = servicePathFor(
      servicePlatform,
      options.homeDirectory ?? homedir(),
    )
    const installed = yield* Effect.promise(() => fileExists(servicePath))
    if (!installed) return false
    if (options.executeCommands === false) return true

    yield* Effect.tryPromise({
      try: () =>
        runServiceAction(
          action,
          servicePlatform,
          servicePath,
          options.runCommand,
        ),
      catch: (cause) =>
        new ServiceInstallError({
          message: `failed to ${action} ${servicePlatform} service`,
          cause,
        }),
    })
    return true
  })

export const installService = (
  config: ClaudegramConfig,
  options: ServiceInstallOptions = {},
): Effect.Effect<ServiceResult, ServiceInstallError> =>
  Effect.gen(function* () {
    const servicePlatform = yield* detectPlatform(options.platform ?? platform())
    const homeDirectory = options.homeDirectory ?? homedir()
    const servicePath = servicePathFor(servicePlatform, homeDirectory)
    const invocation = invocationForDaemon(options.invocationCommand)
    const definition =
      servicePlatform === 'darwin'
        ? launchdDefinition(invocation, join(dirname(config.socketPath), 'daemon.log'))
        : systemdDefinition(invocation)
    yield* Effect.tryPromise({
      try: () => writeAtomic(servicePath, definition),
      catch: (cause) =>
        new ServiceInstallError({ message: `failed to write ${servicePath}`, cause }),
    })

    if (options.executeCommands !== false) {
      yield* Effect.tryPromise({
        try: async () => {
          if (servicePlatform === 'darwin') {
            await runServiceAction(
              'start',
              servicePlatform,
              servicePath,
              options.runCommand,
            )
          } else {
            const execute = options.runCommand ?? runCommand
            await execute('systemctl', ['--user', 'daemon-reload'])
            await execute('systemctl', [
              '--user',
              'enable',
              '--now',
              'claudegram.service',
            ])
          }
        },
        catch: (cause) =>
          new ServiceInstallError({
            message: `service file was written, but ${servicePlatform} activation failed`,
            cause,
          }),
      })
    }

    return { servicePath, installed: true, platform: servicePlatform }
  })

export const uninstallService = (
  options: ServiceInstallOptions = {},
): Effect.Effect<ServiceResult, ServiceInstallError> =>
  Effect.gen(function* () {
    const servicePlatform = yield* detectPlatform(options.platform ?? platform())
    const homeDirectory = options.homeDirectory ?? homedir()
    const servicePath = servicePathFor(servicePlatform, homeDirectory)
    const installed = yield* Effect.promise(() => fileExists(servicePath))

    if (installed && options.executeCommands !== false) {
      yield* Effect.tryPromise({
        try: async () => {
          if (servicePlatform === 'darwin') {
            await runServiceAction(
              'stop',
              servicePlatform,
              servicePath,
              options.runCommand,
            )
          } else {
            const execute = options.runCommand ?? runCommand
            await execute('systemctl', [
              '--user',
              'disable',
              '--now',
              'claudegram.service',
            ])
            await execute('systemctl', ['--user', 'daemon-reload'])
          }
        },
        catch: (cause) =>
          new ServiceInstallError({ message: 'failed to deactivate service', cause }),
      })
    }

    yield* Effect.tryPromise({
      try: () => unlink(servicePath).catch(() => undefined),
      catch: (cause) =>
        new ServiceInstallError({ message: `failed to remove ${servicePath}`, cause }),
    })

    return { servicePath, installed: false, platform: servicePlatform }
  })

export const inspectService = (
  options: ServiceInstallOptions = {},
): Effect.Effect<ServiceResult, ServiceInstallError> =>
  Effect.gen(function* () {
    const servicePlatform = yield* detectPlatform(options.platform ?? platform())
    const servicePath = servicePathFor(
      servicePlatform,
      options.homeDirectory ?? homedir(),
    )
    const installed = yield* Effect.promise(() => fileExists(servicePath))
    return { servicePath, installed, platform: servicePlatform }
  })

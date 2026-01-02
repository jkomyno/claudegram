import { execFile } from 'node:child_process'

import * as Effect from 'effect/Effect'

import type { ClaudegramConfig } from './config'
import { inspectDaemon } from './daemon'
import { CLAUDEGRAM_HOOK_EVENTS, inspectHooks } from './hook-settings'

export type DoctorCheckStatus = 'pass' | 'fail' | 'warn'

export interface DoctorCheck {
  readonly name: string
  readonly status: DoctorCheckStatus
  readonly message: string
}

export interface DoctorReport {
  readonly healthy: boolean
  readonly checks: ReadonlyArray<DoctorCheck>
}

export interface DoctorOptions {
  readonly config: ClaudegramConfig
  readonly homeDirectory?: string
  readonly tmuxExecutable?: string
  readonly inspectDaemonState?: typeof inspectDaemon
}

const commandVersion = (executable: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(executable, ['-V'], { encoding: 'utf8' }, (cause, stdout) => {
      resolve(cause === null ? stdout.trim() : undefined)
    })
  })

export const runDoctor = (
  options: DoctorOptions,
): Effect.Effect<DoctorReport> =>
  Effect.promise(async () => {
    const checks: Array<DoctorCheck> = []
    checks.push(
      options.config.botToken === undefined
        ? {
            name: 'bot-token',
            status: 'fail',
            message: 'CLAUDEGRAM_BOT_TOKEN and config botToken are both missing.',
          }
        : {
            name: 'bot-token',
            status: 'pass',
            message: 'Bot token is configured.',
          },
    )
    checks.push(
      options.config.chatId === undefined
        ? {
            name: 'chat-id',
            status: 'fail',
            message: 'Telegram chat id is missing.',
          }
        : {
            name: 'chat-id',
            status: 'pass',
            message: `Telegram chat id ${options.config.chatId} is configured.`,
        },
    )
    checks.push(
      options.config.ownerUserId === undefined
        ? {
            name: 'owner-user-id',
            status: 'fail',
            message: 'Telegram owner user id is missing. Run claudegram setup.',
          }
        : {
            name: 'owner-user-id',
            status: 'pass',
            message: `Telegram user ${options.config.ownerUserId} is authorized.`,
          },
    )

    const daemon = await Effect.runPromise(
      (options.inspectDaemonState ?? inspectDaemon)(options.config),
    ).catch(() => ({ status: 'stopped' as const }))
    checks.push(
      daemon.status === 'running'
        ? {
            name: 'daemon',
            status: 'pass',
            message: `Daemon ${daemon.pid} is running and its socket accepts connections.`,
          }
        : {
            name: 'daemon',
            status: 'fail',
            message:
              daemon.status === 'degraded'
                ? `Daemon ${daemon.pid} is alive, but its socket is unavailable.`
                : 'Daemon socket is unavailable.',
          },
    )

    const tmuxVersion = await commandVersion(options.tmuxExecutable ?? 'tmux')
    checks.push(
      tmuxVersion === undefined
        ? {
            name: 'tmux',
            status: 'fail',
            message: 'tmux is missing or not executable from PATH.',
          }
        : {
            name: 'tmux',
            status: 'pass',
            message: tmuxVersion,
          },
    )

    const hookState = await Effect.runPromise(
      inspectHooks({ scope: 'global', homeDirectory: options.homeDirectory }),
    ).catch(() => undefined)
    checks.push(
      hookState?.eventCount === CLAUDEGRAM_HOOK_EVENTS.length
        ? {
            name: 'hooks',
            status: 'pass',
            message: 'All global Claude Code hooks are installed.',
          }
        : {
            name: 'hooks',
            status: 'warn',
            message: `Global hook coverage is ${hookState?.eventCount ?? 0}/${CLAUDEGRAM_HOOK_EVENTS.length}.`,
          },
    )

    return {
      healthy: checks.every((check) => check.status !== 'fail'),
      checks,
    }
  })

import { createInterface } from 'node:readline/promises'

import type { WizardPrompt } from '@claudegram/core'

const requireInteractiveInput = (): void => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive setup requires a terminal. Use --no-input with configured environment variables.')
  }
}

const question = async (message: string): Promise<string> => {
  requireInteractiveInput()
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await terminal.question(`${message}: `)
  } finally {
    terminal.close()
  }
}

const secret = async (message: string): Promise<string> => {
  requireInteractiveInput()
  const input = process.stdin
  const output = process.stdout

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
    }
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString()
      for (const character of text) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('Setup cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(value)
          return
        }
        if (character === '\u007f') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
          continue
        }
        value += character
        output.write('*')
      }
    }

    output.write(`${message}: `)
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

export const terminalWizardPrompt: WizardPrompt = {
  secret,
  text: question,
  confirm: async (message, defaultValue) => {
    const suffix = defaultValue ? '[Y/n]' : '[y/N]'
    const answer = (await question(`${message} ${suffix}`)).trim().toLowerCase()
    if (answer.length === 0) return defaultValue
    return answer === 'y' || answer === 'yes'
  },
  note: async (message) => {
    process.stdout.write(`${message}\n`)
  },
}

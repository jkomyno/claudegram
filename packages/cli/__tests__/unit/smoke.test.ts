import { describe, expect, it } from 'vitest'

import { CLI_NAME } from '../../src/bin'

describe('scaffold', () => {
  it('names the CLI', () => {
    expect(CLI_NAME).toBe('claudegram')
  })
})

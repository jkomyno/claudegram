import { describe, expect, it } from 'vitest'

import { CLI_NAME } from '../../src/constants'

describe('scaffold', () => {
  it('names the CLI', () => {
    expect(CLI_NAME).toBe('claudegram')
  })
})

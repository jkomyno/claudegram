import { describe, expect, it } from 'vitest'

import { CLAUDEGRAM_CORE_VERSION } from '../../src'

describe('scaffold', () => {
  it('exposes the core version', () => {
    expect(CLAUDEGRAM_CORE_VERSION).toBe('0.0.0')
  })
})

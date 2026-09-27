import { describe, it, expect } from 'vitest'
import { validPrice, buildCallHeaders } from './llmConfig'

describe('validPrice', () => {
  it('passes through finite non-negative numbers', () => {
    for (const v of [0, 0.5, 3, 1e6]) {
      expect(validPrice(v)).toBe(v)
    }
  })

  it('drops everything else', () => {
    for (const v of [-1, NaN, Infinity, -Infinity, '1', null, undefined]) {
      expect(validPrice(v)).toBeUndefined()
    }
  })
})

describe('buildCallHeaders', () => {
  const SENTINEL = '{{apiKey}}'

  it('splices the key in when one is stored', () => {
    const headers = buildCallHeaders(
      { Authorization: 'Bearer {{apiKey}}' },
      SENTINEL,
      { apiKey: 'sk-real', noKey: false },
    )
    expect(headers).toEqual({ Authorization: 'Bearer sk-real' })
  })

  it('drops the sentinel-carrying header when the target needs no key', () => {
    const headers = buildCallHeaders(
      { Authorization: 'Bearer {{apiKey}}', 'Content-Type': 'application/json' },
      SENTINEL,
      { noKey: true },
    )
    expect(headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('throws when there is neither a stored key nor noKey', () => {
    expect(() => buildCallHeaders({ Authorization: 'Bearer {{apiKey}}' }, SENTINEL, {})).toThrow(
      'No API key is stored for this target.',
    )
  })
})

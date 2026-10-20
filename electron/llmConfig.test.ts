import { describe, it, expect } from 'vitest'
import {
  validPrice, buildCallHeaders, validSystemOneFlavor, validAccountId, validManaged, validPositiveInt, managedTargetUrl,
} from './llmConfig'

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

describe('managed target validators', () => {
  it('validSystemOneFlavor keeps only the two flavors', () => {
    expect(validSystemOneFlavor('jev')).toBe('jev')
    expect(validSystemOneFlavor('cloudflare')).toBe('cloudflare')
    expect(validSystemOneFlavor('x')).toBeUndefined()
    expect(validSystemOneFlavor(1)).toBeUndefined()
  })

  it('validAccountId needs exactly 32 lowercase hex chars', () => {
    expect(validAccountId('a'.repeat(32))).toBe('a'.repeat(32))
    for (const v of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 7, undefined]) {
      expect(validAccountId(v)).toBeUndefined()
    }
  })

  it('validManaged keeps a well-formed catalog id only', () => {
    expect(validManaged({ catalogId: 'laya-en-q8' })).toEqual({ catalogId: 'laya-en-q8' })
    for (const v of [{ catalogId: '../x' }, { catalogId: 'A' }, { catalogId: '' }, { catalogId: 'a'.repeat(65) }, null, 'x', {}]) {
      expect(validManaged(v)).toBeUndefined()
    }
  })

  it('validPositiveInt rejects zero, fractions and strings', () => {
    expect(validPositiveInt(512)).toBe(512)
    for (const v of [0, -1, 1.5, '512', NaN]) expect(validPositiveInt(v)).toBeUndefined()
  })

  it('managedTargetUrl swaps the origin and limits paths', () => {
    expect(managedTargetUrl('http://127.0.0.1/v1/systemone?a=1', 'http://127.0.0.1:5555')).toBe(
      'http://127.0.0.1:5555/v1/systemone?a=1',
    )
    expect(managedTargetUrl('http://127.0.0.1/health', 'http://127.0.0.1:5555')).toBe('http://127.0.0.1:5555/health')
    expect(() => managedTargetUrl('http://127.0.0.1/props', 'http://127.0.0.1:5555')).toThrow()
    expect(() => managedTargetUrl('http://127.0.0.1/v1/../props', 'http://127.0.0.1:5555')).toThrow()
  })
})

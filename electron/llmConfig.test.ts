import { describe, it, expect } from 'vitest'
import { validPrice } from './llmConfig'

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

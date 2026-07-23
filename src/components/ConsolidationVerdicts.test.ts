import { describe, expect, it } from 'vitest'
import { consolidationFieldStatus } from './ConsolidationVerdicts'

describe('consolidationFieldStatus', () => {
  it('marks agreement only when every reviewer answered', () => {
    expect(consolidationFieldStatus(2, 2, true)).toBe('agree')
    expect(consolidationFieldStatus(2, 3, true)).toBeUndefined()
  })

  it('marks any observed disagreement red, even while another reviewer is pending', () => {
    expect(consolidationFieldStatus(2, 2, false)).toBe('disagree')
    expect(consolidationFieldStatus(2, 3, false)).toBe('disagree')
    expect(consolidationFieldStatus(3, 3, false)).toBe('disagree')
  })

  it('leaves fields with fewer than two answers neutral', () => {
    expect(consolidationFieldStatus(0, 3, true)).toBeUndefined()
    expect(consolidationFieldStatus(1, 3, true)).toBeUndefined()
  })
})
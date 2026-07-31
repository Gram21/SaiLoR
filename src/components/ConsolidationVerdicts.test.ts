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

  it('marks a field in an entry only one reviewer recorded red', () => {
    // One answer cannot disagree with itself, so the two-answer rule above
    // leaves this neutral — but the entry itself is the disagreement: one
    // reviewer found this finding and another did not. Without this the
    // consolidator sees no signal at all on the groups they must rule on.
    expect(consolidationFieldStatus(1, 2, true, true)).toBe('disagree')
    expect(consolidationFieldStatus(1, 3, true, true)).toBe('disagree')
  })

  it('does not colour an empty field inside a one-sided entry', () => {
    // Nobody filled this one in, so there is nothing to keep or drop — an
    // empty row, not a dispute.
    expect(consolidationFieldStatus(0, 2, true, true)).toBeUndefined()
  })

  it('still prefers agreement when everyone answered a one-sided entry', () => {
    // Belt and braces: `oneSided` must never downgrade a genuine full-house
    // agreement, whatever a stale mapping claims about membership.
    expect(consolidationFieldStatus(2, 2, true, true)).toBe('agree')
  })
})
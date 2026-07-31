import { describe, expect, it } from 'vitest'
import { consolidationFieldStatus } from './ConsolidationVerdicts'

describe('consolidationFieldStatus', () => {
  it('marks agreement only when every reviewer answered', () => {
    expect(consolidationFieldStatus(2, 2, true)).toBe('agree')
    // Two of three agreeing is not yet consensus — the third has not spoken.
    expect(consolidationFieldStatus(2, 3, true, false, 3)).not.toBe('agree')
  })

  it('marks any observed disagreement red, even while another reviewer is pending', () => {
    expect(consolidationFieldStatus(2, 2, false)).toBe('disagree')
    expect(consolidationFieldStatus(2, 3, false)).toBe('disagree')
    expect(consolidationFieldStatus(3, 3, false)).toBe('disagree')
  })

  it('leaves a field nobody has answered neutral', () => {
    expect(consolidationFieldStatus(0, 3, true)).toBeUndefined()
    expect(consolidationFieldStatus(0, 3, true, false, 3)).toBeUndefined()
  })

  it('marks a field one participant answered and another left blank', () => {
    // One value against one silence. Not two answers in conflict, so the
    // two-answer rule never fires — but the consolidator still has to decide
    // whether to take the value or accept the blank.
    expect(consolidationFieldStatus(1, 2, true, false, 2)).toBe('disagree')
    expect(consolidationFieldStatus(2, 3, true, false, 3)).toBe('disagree')
  })

  it('does not flag a field against a reviewer who has not started the paper', () => {
    // Default `participantCount` is the configured reviewer count, but a paper
    // only one person has opened has one participant — their answer is not
    // contested by a seat that has recorded nothing anywhere.
    expect(consolidationFieldStatus(1, 3, true, false, 1)).toBeUndefined()
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

  it('never calls a one-sided entry agreement, even when the values match', () => {
    // The trap this ordering exists for: a Yes/No nobody ticked reads as a
    // shared `false`, so by value the two reviewers "agree" — about a finding
    // only one of them ever recorded. Green there claims a consensus that was
    // never reached.
    expect(consolidationFieldStatus(2, 2, true, true)).toBe('disagree')
  })
})
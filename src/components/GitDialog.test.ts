import { describe, it, expect } from 'vitest'
import { mixedDiscardConfirmMessage } from './GitDialog'

describe('mixedDiscardConfirmMessage (warn before a commit silently reverts a Discard row)', () => {
  it('warns when a Discard row is mixed in among Use rows', () => {
    const msg = mixedDiscardConfirmMessage(false, true, 2, 'review.json')
    expect(msg).not.toBeNull()
    expect(msg).toContain('2 fields')
    expect(msg).toContain('review.json')
    expect(msg).toContain('cannot be undone')
  })

  it('singular wording for exactly one Discard row', () => {
    const msg = mixedDiscardConfirmMessage(false, true, 1, 'review.json')
    expect(msg).toContain('1 field ')
    expect(msg).not.toContain('1 fields')
    expect(msg).toContain('that change')
  })

  it('does not warn when there is no Discard row at all', () => {
    expect(mixedDiscardConfirmMessage(false, false, 0, 'review.json')).toBeNull()
  })

  it('does not warn in discard-only mode — that path has its own separate confirm', () => {
    expect(mixedDiscardConfirmMessage(true, true, 3, 'review.json')).toBeNull()
  })
})

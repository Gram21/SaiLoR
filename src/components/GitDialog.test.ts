import { describe, it, expect } from 'vitest'
import { mixedDiscardConfirmMessage, isProjectOwnPath } from './GitDialog'

describe('mixedDiscardConfirmMessage (warn before a commit silently reverts or deletes a Discard row)', () => {
  it('warns when a Discard row is mixed in among Use rows (field-only)', () => {
    const msg = mixedDiscardConfirmMessage(false, true, 2, 0, 'review.json')
    expect(msg).not.toBeNull()
    expect(msg).toContain('2 fields')
    expect(msg).toContain('review.json')
    expect(msg).toContain('cannot be undone')
  })

  it('singular wording for exactly one Discard row (field-only)', () => {
    const msg = mixedDiscardConfirmMessage(false, true, 1, 0, 'review.json')
    expect(msg).toContain('1 field ')
    expect(msg).not.toContain('1 fields')
    expect(msg).toContain('that change')
  })

  it('does not warn when there is no Discard row at all', () => {
    expect(mixedDiscardConfirmMessage(false, false, 0, 0, 'review.json')).toBeNull()
  })

  it('does not warn in discard-only mode — that path has its own separate confirm', () => {
    expect(mixedDiscardConfirmMessage(true, true, 3, 0, 'review.json')).toBeNull()
  })

  // Bug 4: a `PaperChange` marked Discard is not "a field" — discarding an
  // *added* paper deletes it and every one of its annotation files
  // (consolidated.json, every reviewer-<n>.json). The old shared count
  // called this "1 field ... reverted", badly underselling what is lost.
  it('paper-only: names the paper explicitly, not as a field', () => {
    const msg = mixedDiscardConfirmMessage(false, true, 0, 1, 'review.json')
    expect(msg).not.toBeNull()
    expect(msg).toContain('1 paper')
    expect(msg).not.toMatch(/\bfield\b/)
    expect(msg).toMatch(/deleted/i)
    expect(msg).toContain('cannot be undone')
  })

  it('paper-only: plural wording for more than one paper', () => {
    const msg = mixedDiscardConfirmMessage(false, true, 0, 2, 'review.json')
    expect(msg).toContain('2 papers')
    expect(msg).not.toContain('2 paper ')
  })

  it('mixed: names both the paper(s) and the field(s), each with their own consequence', () => {
    const msg = mixedDiscardConfirmMessage(false, true, 2, 1, 'review.json')
    expect(msg).toContain('1 paper')
    expect(msg).toMatch(/deleted/i)
    expect(msg).toContain('2 fields')
    expect(msg).toContain('review.json')
    expect(msg).toContain('cannot be undone')
  })
})

describe('isProjectOwnPath (withholds the per-file ↺ from the project\'s own files)', () => {
  it('is true for the project\'s own tracked file', () => {
    expect(isProjectOwnPath('review.json', 'review.json')).toBe(true)
  })

  it('is true for the project\'s own annotations directory and everything under it', () => {
    expect(isProjectOwnPath('annotations', 'review.json')).toBe(true)
    expect(isProjectOwnPath('annotations/p1/consolidated.json', 'review.json')).toBe(true)
    expect(isProjectOwnPath('annotations/p1/reviewer-1.json', 'review.json')).toBe(true)
  })

  it('respects a project file nested in a subfolder', () => {
    expect(isProjectOwnPath('reviews/review.json', 'reviews/review.json')).toBe(true)
    expect(isProjectOwnPath('reviews/annotations/p1/marks-1.json', 'reviews/review.json')).toBe(true)
  })

  it('is false for an unrelated file, even one that merely starts with the same prefix', () => {
    expect(isProjectOwnPath('notes.txt', 'review.json')).toBe(false)
    expect(isProjectOwnPath('annotations-backup/p1/consolidated.json', 'review.json')).toBe(false)
  })
})

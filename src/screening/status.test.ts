import { describe, it, expect } from 'vitest'
import { screeningStatus, screeningReason } from './status'
import type { AnnotationValueTree } from '../model/annotations'

function tree(decision: unknown, reason?: unknown): AnnotationValueTree {
  const t: AnnotationValueTree = { Decision: [{ value: decision as never }] }
  if (reason !== undefined) t.Reason = [{ value: reason as never }]
  return t
}

describe('screeningStatus', () => {
  it('reads Include as included, Exclude as excluded', () => {
    expect(screeningStatus(tree('Include'))).toBe('included')
    expect(screeningStatus(tree('Exclude'))).toBe('excluded')
  })

  it('reads null/undefined tree as undecided', () => {
    expect(screeningStatus(null)).toBe('undecided')
    expect(screeningStatus(undefined)).toBe('undecided')
  })

  it('reads a missing Decision node as undecided', () => {
    expect(screeningStatus({})).toBe('undecided')
  })

  it('reads a hand-edited unknown string as undecided, never as excluded', () => {
    expect(screeningStatus(tree('Maybe'))).toBe('undecided')
  })

  it('reads a non-array Decision value as undecided rather than throwing', () => {
    expect(screeningStatus({ Decision: 'not-an-array' as never })).toBe('undecided')
  })

  it('reads a boolean value (a hand-edited legacy shape) as undecided', () => {
    expect(screeningStatus(tree(true))).toBe('undecided')
  })

  it('reads null Decision value as undecided', () => {
    expect(screeningStatus(tree(null))).toBe('undecided')
  })
})

describe('screeningReason', () => {
  it('reads the recorded reason', () => {
    expect(screeningReason(tree('Exclude', 'Duplicate'))).toBe('Duplicate')
  })

  it('reads null/missing/blank reason as null', () => {
    expect(screeningReason(tree('Exclude', null))).toBeNull()
    expect(screeningReason(tree('Exclude'))).toBeNull()
    expect(screeningReason(tree('Exclude', ''))).toBeNull()
    expect(screeningReason(null)).toBeNull()
  })

  it('does not care whether the paper is actually excluded — callers must check status', () => {
    expect(screeningReason(tree('Include', 'Duplicate'))).toBe('Duplicate')
  })
})

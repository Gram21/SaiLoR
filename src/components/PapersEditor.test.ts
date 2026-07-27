import { describe, it, expect } from 'vitest'
import { duplicatePaperIds } from './PapersEditor'

describe('duplicatePaperIds', () => {
  it('is empty when every id is unique', () => {
    expect(duplicatePaperIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual(new Set())
  })

  it('flags an id shared by two or more papers', () => {
    expect(duplicatePaperIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }])).toEqual(new Set(['a']))
  })

  it('flags every distinct id that repeats, independently', () => {
    const dupes = duplicatePaperIds([{ id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'b' }, { id: 'c' }])
    expect(dupes).toEqual(new Set(['a', 'b']))
  })

  it('compares trimmed values — leading/trailing whitespace does not evade the check', () => {
    expect(duplicatePaperIds([{ id: 'a' }, { id: ' a ' }])).toEqual(new Set(['a']))
  })

  it('does not flag empty ids as duplicates of each other', () => {
    expect(duplicatePaperIds([{ id: '' }, { id: '  ' }, { id: '' }])).toEqual(new Set())
  })

  it('is case-sensitive, matching validateDraft', () => {
    expect(duplicatePaperIds([{ id: 'Paper-A' }, { id: 'paper-a' }])).toEqual(new Set())
  })
})

import { describe, it, expect } from 'vitest'
import { ownAnnotationPathMatcher, ownAnnotationPathsIn } from './ownAnnotationPath'

const project = (papers: string[], screening = false) => ({
  config: { screening: screening ? { reasons: ['x'] } : undefined },
  papers: papers.map((id) => ({ id, title: id, authors: [], pdf: `${id}.pdf` })),
})

describe('ownAnnotationPathMatcher', () => {
  it('matches an in-scope paper id, for every file the family writes', () => {
    const matches = ownAnnotationPathMatcher(project(['p1']))
    expect(matches('p1/consolidated.json')).toBe(true)
    expect(matches('p1/reviewer-1.json')).toBe(true)
    expect(matches('p1/reviewer-2.json')).toBe(true)
    expect(matches('p1/marks-consolidated.json')).toBe(true)
    expect(matches('p1/marks-1.json')).toBe(true)
  })

  it('rejects a paper id outside this project — the sibling case this exists for', () => {
    const matches = ownAnnotationPathMatcher(project(['p1']))
    expect(matches('p2/consolidated.json')).toBe(false)
    expect(matches('p2/reviewer-1.json')).toBe(false)
  })

  it('rejects a filename shape the family does not write, even for an in-scope paper', () => {
    const matches = ownAnnotationPathMatcher(project(['p1']))
    expect(matches('p1/notes.txt')).toBe(false)
    expect(matches('p1/reviewer-x.json')).toBe(false)
    expect(matches('p1.json')).toBe(false)
    expect(matches('consolidated.json')).toBe(false)
  })

  it('uses the screening-<n>/screening-consolidated family when config.screening is set', () => {
    const matches = ownAnnotationPathMatcher(project(['p1'], true))
    expect(matches('p1/screening-consolidated.json')).toBe(true)
    expect(matches('p1/screening-1.json')).toBe(true)
    // The non-screening family's names must not leak through for a screening project.
    expect(matches('p1/consolidated.json')).toBe(false)
    expect(matches('p1/reviewer-1.json')).toBe(false)
  })

  it('does not accept a screening-named file for a non-screening project, or vice versa', () => {
    const nonScreening = ownAnnotationPathMatcher(project(['p1'], false))
    expect(nonScreening('p1/screening-1.json')).toBe(false)
    const screening = ownAnnotationPathMatcher(project(['p1'], true))
    expect(screening('p1/marks-1.json')).toBe(true) // marks are shared by both kinds
  })

  it('is exactly what lets a legitimate screening-to-full-text sibling relationship keep working', () => {
    // The same paper id, same folder, deliberately shared by SaiLoR's own
    // "Start full-text screening" flow — the two projects' matchers must
    // never agree on the same filename, since that is what makes sharing
    // paper ids across the two families safe.
    const screeningMatch = ownAnnotationPathMatcher(project(['p1'], true))
    const derivedMatch = ownAnnotationPathMatcher(project(['p1'], false))
    const screeningFile = 'p1/screening-consolidated.json'
    const derivedFile = 'p1/consolidated.json'
    expect(screeningMatch(screeningFile)).toBe(true)
    expect(derivedMatch(screeningFile)).toBe(false)
    expect(derivedMatch(derivedFile)).toBe(true)
    expect(screeningMatch(derivedFile)).toBe(false)
  })

  it('handles a raw value with no papers array, or a malformed one, as matching nothing', () => {
    expect(ownAnnotationPathMatcher(null)('p1/consolidated.json')).toBe(false)
    expect(ownAnnotationPathMatcher({})('p1/consolidated.json')).toBe(false)
    expect(ownAnnotationPathMatcher({ papers: 'not-an-array' })('p1/consolidated.json')).toBe(false)
    expect(ownAnnotationPathMatcher({ papers: [{ id: 42 }] })('p1/consolidated.json')).toBe(false)
  })
})

describe('ownAnnotationPathsIn', () => {
  const changes = [
    { path: 'annotations/p1/consolidated.json' },
    { path: 'annotations/p1/reviewer-2.json' },
    // A sibling project sharing the folder — the whole reason this exists.
    { path: 'annotations/q9/consolidated.json' },
    // Not the family's naming, and not under the folder at all.
    { path: 'annotations/p1/notes.txt' },
    { path: 'papers/p1.pdf' },
  ]

  it('takes this project\'s own changed files and leaves a sibling\'s alone', () => {
    expect(ownAnnotationPathsIn(changes, 'annotations', project(['p1']))).toEqual([
      'annotations/p1/consolidated.json',
      'annotations/p1/reviewer-2.json',
    ])
  })

  it('stages both halves of a rename, or the old name is left behind', () => {
    const renamed = [{ path: 'annotations/p1/reviewer-2.json', from: 'annotations/p1/reviewer-1.json' }]
    expect(ownAnnotationPathsIn(renamed, 'annotations', project(['p1']))).toEqual([
      'annotations/p1/reviewer-2.json',
      'annotations/p1/reviewer-1.json',
    ])
  })

  it('returns nothing when the project owns none of the changed paths', () => {
    expect(ownAnnotationPathsIn(changes, 'annotations', project(['zz']))).toEqual([])
  })
})

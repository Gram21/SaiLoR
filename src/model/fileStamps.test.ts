import { describe, it, expect } from 'vitest'
import { changedTargets, staleSaveError } from './fileStamps'

/**
 * The lost update this guards against: a teammate's `git pull` lands answers
 * in the working tree while SaiLoR has the project open, and the next save
 * writes the in-memory copy straight over them — no conflict, no warning, no
 * trace that the pulled answers ever existed.
 */
describe('changedTargets', () => {
  it('passes a file that is exactly as we left it', () => {
    expect(changedTargets([{ rel: 'a.json', known: '100:20', now: '100:20' }])).toEqual([])
  })

  it('catches a file something else rewrote', () => {
    expect(changedTargets([{ rel: 'a.json', known: '100:20', now: '200:25' }])).toEqual(['a.json'])
  })

  it('catches a file that appeared since we read the project', () => {
    // A reviewer who had no answers for this paper now does, because somebody
    // pulled their work in. Writing over it would delete a whole reading.
    expect(changedTargets([{ rel: 'a.json', known: undefined, now: '100:20' }])).toEqual(['a.json'])
  })

  it('allows creating a file that is not there', () => {
    expect(changedTargets([{ rel: 'a.json', known: undefined, now: null }])).toEqual([])
  })

  it('allows deleting one already gone', () => {
    expect(changedTargets([{ rel: 'a.json', known: '100:20', now: null }])).toEqual([])
  })

  it('catches a same-size rewrite, which mtime alone would miss', () => {
    expect(changedTargets([{ rel: 'a.json', known: '100:20', now: '300:20' }])).toEqual(['a.json'])
  })

  it('reports every changed path, not just the first', () => {
    expect(
      changedTargets([
        { rel: 'a.json', known: '1:1', now: '1:1' },
        { rel: 'b.json', known: '1:1', now: '2:1' },
        { rel: 'c.json', known: undefined, now: '9:9' },
      ]),
    ).toEqual(['b.json', 'c.json'])
  })
})

describe('staleSaveError', () => {
  it('is null when nothing changed, so an ordinary save is never interrupted', () => {
    expect(staleSaveError([{ rel: 'a.json', known: '1:1', now: '1:1' }])).toBeNull()
  })

  it('names the files and what to do about them', () => {
    const message = staleSaveError([{ rel: 'annotations/p1/reviewer-2.json', known: '1:1', now: '2:2' }])
    expect(message).toContain('annotations/p1/reviewer-2.json')
    expect(message).toMatch(/reopen the project/i)
  })

  it('caps the list rather than printing a whole corpus', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ rel: `f${i}.json`, known: '1:1', now: '2:2' }))
    const message = staleSaveError(many)!
    expect(message).toContain('…and 15 more')
    expect(message).not.toContain('f20.json')
  })
})

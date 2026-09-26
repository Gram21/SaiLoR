import { describe, it, expect } from 'vitest'
import {
  seatFileFor,
  parseAnnotationAuthors,
  sameIdentity,
  seatTakenByOther,
} from './seatOwner'

const ANNA = { name: 'Anna Schmidt', email: 'anna@example.org' }
const AXEL = { name: 'Axel Braun', email: 'axel@example.org' }

describe('seatFileFor', () => {
  it('names the file a seat writes for one paper', () => {
    expect(seatFileFor('p1', '2', false)).toBe('p1/reviewer-2.json')
    expect(seatFileFor('p1', 'consolidation', false)).toBe('p1/consolidated.json')
  })

  it('uses the screening family for a screening project', () => {
    expect(seatFileFor('p1', '1', true)).toBe('p1/screening-1.json')
    expect(seatFileFor('p1', 'consolidation', true)).toBe('p1/screening-consolidated.json')
  })
})

describe('parseAnnotationAuthors', () => {
  /** `git log --no-merges --format=%x00%an%x09%ae --name-only`, newest first. */
  const log = [
    '\0Anna Schmidt\tanna@example.org\nannotations/p1/reviewer-1.json\nannotations/p2/reviewer-1.json\n',
    '\0Axel Braun\taxel@example.org\nannotations/p1/reviewer-1.json\nannotations/p3/reviewer-2.json\n',
  ].join('')

  it('takes the newest commit that touched each file', () => {
    const files = parseAnnotationAuthors(log, 'annotations')
    // Both wrote p1/reviewer-1; Anna's commit is newer, so it is hers.
    expect(files['p1/reviewer-1.json']).toEqual(ANNA)
    expect(files['p3/reviewer-2.json']).toEqual(AXEL)
  })

  it('strips the folder prefix so keys match seatFileFor', () => {
    const files = parseAnnotationAuthors(log, 'annotations')
    expect(Object.keys(files)).toContain(seatFileFor('p2', '1', false))
  })

  it('ignores paths outside the project\'s own folder', () => {
    const stray = '\0Anna Schmidt\tanna@example.org\nREADME.md\nother/annotations/p9/reviewer-1.json\n'
    expect(parseAnnotationAuthors(stray, 'annotations')).toEqual({})
  })

  it('is empty for a repository with no commits touching the folder', () => {
    expect(parseAnnotationAuthors('', 'annotations')).toEqual({})
  })
})

describe('sameIdentity', () => {
  it('matches on email regardless of how the name is spelled', () => {
    expect(sameIdentity({ name: 'Anna Schmidt', email: 'Anna@Example.org' }, { name: 'anna', email: 'anna@example.org' })).toBe(true)
  })

  it('separates two people sharing a display name', () => {
    expect(sameIdentity({ name: 'A. S.', email: 'anna@example.org' }, { name: 'A. S.', email: 'axel@example.org' })).toBe(false)
  })

  it('falls back to the name when neither side has an email', () => {
    expect(sameIdentity({ name: 'Anna', email: '' }, { name: 'Anna', email: '' })).toBe(true)
    expect(sameIdentity({ name: 'Anna', email: '' }, { name: 'Axel', email: '' })).toBe(false)
  })

  it('is false for nobody — an unwritten seat is not everybody', () => {
    expect(sameIdentity(null, ANNA)).toBe(false)
    expect(sameIdentity({ name: '', email: '' }, { name: '', email: '' })).toBe(false)
  })
})

describe('seatTakenByOther', () => {
  const authors = { me: ANNA, files: { 'p1/reviewer-1.json': AXEL, 'p2/reviewer-1.json': ANNA } }

  it('names the other person who already read this paper in this seat', () => {
    expect(seatTakenByOther(authors, 'p1', '1', false)).toEqual(AXEL)
  })

  it('says nothing about a paper this same person already read', () => {
    expect(seatTakenByOther(authors, 'p2', '1', false)).toBeNull()
  })

  it('says nothing about the other seat on a contested paper', () => {
    // The whole point: a seat is not a person. Axel holding seat 1 on p1 must
    // not warn anyone off seat 2 there, nor off seat 1 anywhere else.
    expect(seatTakenByOther(authors, 'p1', '2', false)).toBeNull()
    expect(seatTakenByOther(authors, 'p3', '1', false)).toBeNull()
  })

  it('says nothing outside a git repository', () => {
    expect(seatTakenByOther(null, 'p1', '1', false)).toBeNull()
  })

  it('says nothing when this machine has no identity configured', () => {
    // Everyone would otherwise look like somebody else.
    expect(seatTakenByOther({ me: null, files: authors.files }, 'p1', '1', false)).toBeNull()
  })
})

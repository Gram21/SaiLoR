import { describe, it, expect } from 'vitest'
import { parseStashList, describeStash, stashBranchName, BRANCH_SWITCH_STASH_MESSAGE } from './stash'

/** One record as `git stash list --format=STASH_LIST_FORMAT` prints it. */
const rec = (ref: string, sha: string, date: string, subject: string) => `${ref}\t${sha}\t${date}\t${subject}\0`

describe('parseStashList', () => {
  it('unpacks a named stash into branch and message', () => {
    const [e] = parseStashList(rec('stash@{0}', 'abc', '2026-09-23T10:00:00+02:00', 'On main: sailor stash: before pulling'))
    expect(e).toEqual({
      sha: 'abc',
      ref: 'stash@{0}',
      date: '2026-09-23T10:00:00+02:00',
      branch: 'main',
      message: 'sailor stash: before pulling',
      origin: 'sailor',
    })
  })

  it('unpacks an unnamed one made in a terminal', () => {
    const [e] = parseStashList(rec('stash@{0}', 'def', '2026-09-23T10:00:00Z', 'WIP on feature: 1a2b3c4 Fix typo'))
    expect(e.branch).toBe('feature')
    expect(e.origin).toBe('other')
  })

  it("recognises SaiLoR's own branch-switch stash, so it can say why it exists", () => {
    // The stash a failed branch-switch abort leaves behind — the one nobody
    // knew was there until the list existed.
    const [e] = parseStashList(rec('stash@{0}', 'aaa', '2026-09-23T10:00:00Z', `On main: ${BRANCH_SWITCH_STASH_MESSAGE}`))
    expect(e.origin).toBe('branch-switch')
  })

  it('keeps git order, newest first', () => {
    const list = parseStashList(
      rec('stash@{0}', 'new', '2026-09-23T11:00:00Z', 'On main: b') + rec('stash@{1}', 'old', '2026-09-22T11:00:00Z', 'On main: a'),
    )
    expect(list.map((e) => e.sha)).toEqual(['new', 'old'])
  })

  it('keeps a message containing a colon or tab intact', () => {
    const [e] = parseStashList(rec('stash@{0}', 'x', 'd', 'On main: sailor stash: note: see\tabove'))
    expect(e.message).toBe('sailor stash: note: see\tabove')
  })

  it('is empty for no stashes, and skips a malformed record rather than throwing', () => {
    expect(parseStashList('')).toEqual([])
    expect(parseStashList('garbage\0' + rec('stash@{0}', 'ok', 'd', 'On main: m'))).toHaveLength(1)
  })
})

describe('describeStash', () => {
  const base = { sha: 's', ref: 'stash@{0}', date: '2026-09-23', branch: 'main' }

  it('explains a stash left behind by a branch switch', () => {
    expect(describeStash({ ...base, message: BRANCH_SWITCH_STASH_MESSAGE, origin: 'branch-switch' })).toMatch(/switching branches/)
  })

  it('shows the reviewer their own note without the prefix', () => {
    expect(describeStash({ ...base, message: 'sailor stash: half-done p12', origin: 'sailor' })).toBe('half-done p12')
  })

  it("passes a terminal stash's message through", () => {
    expect(describeStash({ ...base, message: 'WIP thing', origin: 'other' })).toBe('WIP thing')
  })
})

describe('stashBranchName', () => {
  const entry = { sha: 's', ref: 'stash@{0}', date: '2026-09-23T10:00:00Z', branch: 'main', message: 'm', origin: 'other' as const }

  it('names the branch after the day the stash was made', () => {
    expect(stashBranchName(entry, ['main'])).toBe('restored-stash-2026-09-23')
  })

  it('never collides with a branch that already exists', () => {
    expect(stashBranchName(entry, ['restored-stash-2026-09-23', 'restored-stash-2026-09-23-2'])).toBe(
      'restored-stash-2026-09-23-3',
    )
  })
})

describe('a reviewer\'s own note is never mistaken for the carry-over', () => {
  it('keeps "switching branch" typed by hand as the reviewer\'s own stash', () => {
    const [e] = parseStashList(rec('stash@{0}', 'x', 'd', 'On main: sailor stash: switching branch'))
    expect(e.origin).toBe('sailor')
  })
})

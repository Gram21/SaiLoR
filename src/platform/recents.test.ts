import { describe, it, expect, beforeEach } from 'vitest'
import { readRecents, pushRecent, removeRecent, shortenPath, MAX_RECENTS } from './recents'

// The test environment provides no localStorage (recents.ts guards for exactly
// that), so stand one up before importing anything that touches it.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

const KEY = 'test.recents'

describe('shortenPath', () => {
  it('keeps the tail — the folder and file are what identify the project', () => {
    expect(shortenPath('/Users/keim/Documents/Research/2026/code-search/review.json')).toBe(
      '…/2026/code-search/review.json',
    )
  })

  it('leaves a path that already fits alone', () => {
    expect(shortenPath('/tmp/short.json')).toBe('/tmp/short.json')
    expect(shortenPath('review.json')).toBe('review.json')
  })

  it('keeps two same-named projects distinguishable', () => {
    // The whole point: identical file names, different folders.
    const a = shortenPath('/deep/deep/deep/reviews/2026/code-search/review.json')
    const b = shortenPath('/deep/deep/deep/reviews/2025/program-repair/review.json')
    expect(a).not.toBe(b)
    expect(a).toContain('code-search')
    expect(b).toContain('program-repair')
  })

  it('handles Windows separators', () => {
    expect(shortenPath('C:\\Users\\keim\\Documents\\reviews\\2026\\review.json')).toBe(
      '…/reviews/2026/review.json',
    )
  })
})

describe('recents', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the path and the title alongside the name', () => {
    pushRecent(KEY, {
      id: '/a/review.json',
      name: 'review.json',
      path: '/a/review.json',
      title: 'My Review',
    })
    expect(readRecents(KEY)[0]).toEqual({
      id: '/a/review.json',
      name: 'review.json',
      path: '/a/review.json',
      title: 'My Review',
    })
  })

  it('distinguishes same-named projects in different folders', () => {
    // This is the whole point of storing the path: two "review.json" files.
    pushRecent(KEY, { id: '/a/review.json', name: 'review.json', path: '/a/review.json' })
    pushRecent(KEY, { id: '/b/review.json', name: 'review.json', path: '/b/review.json' })

    const list = readRecents(KEY)
    expect(list).toHaveLength(2)
    expect(list.map((e) => e.path)).toEqual(['/b/review.json', '/a/review.json'])
  })

  it('re-pushing the same id enriches the entry rather than duplicating it', () => {
    // The adapter pushes on open (no title yet); the store re-pushes once the
    // JSON is parsed and the title is known.
    pushRecent(KEY, { id: '/a/review.json', name: 'review.json', path: '/a/review.json' })
    pushRecent(KEY, {
      id: '/a/review.json',
      name: 'review.json',
      path: '/a/review.json',
      title: 'My Review',
    })

    const list = readRecents(KEY)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('My Review')
  })

  it('removes an entry the user dismissed, leaving the others', () => {
    pushRecent(KEY, { id: '/a.json', name: 'a.json' })
    pushRecent(KEY, { id: '/b.json', name: 'b.json' })

    const left = removeRecent(KEY, '/a.json')
    expect(left.map((e) => e.id)).toEqual(['/b.json'])
    // And it is gone from storage, not just the returned list.
    expect(readRecents(KEY).map((e) => e.id)).toEqual(['/b.json'])
  })

  it('tolerates entries written before path/title existed', () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: '/old.json', name: 'old.json' }]))
    const list = readRecents(KEY)
    expect(list[0].name).toBe('old.json')
    expect(list[0].path).toBeUndefined()
    expect(list[0].title).toBeUndefined()
  })

  it('caps the list', () => {
    for (let i = 0; i < MAX_RECENTS + 3; i++) {
      pushRecent(KEY, { id: `/p${i}.json`, name: `p${i}.json` })
    }
    expect(readRecents(KEY)).toHaveLength(MAX_RECENTS)
  })
})

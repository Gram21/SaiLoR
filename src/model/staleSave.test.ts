import { describe, it, expect } from 'vitest'
import { loadProject, type Project } from './project'
import { resolveClash } from './staleSave'

const project = (papers: Array<{ id: string; r1?: string; r2?: string }>, title = 'T'): Project =>
  loadProject(
    JSON.stringify({
      version: 1,
      title,
      config: { reviewers: 2, schema: [{ name: 'Note', type: 'string' }] },
      papers: papers.map((p) => ({
        id: p.id,
        title: p.id,
        authors: [],
        pdf: `${p.id}.pdf`,
        annotations: {},
        reviews: {
          ...(p.r1 ? { 1: { Note: [{ value: p.r1 }] } } : {}),
          ...(p.r2 ? { 2: { Note: [{ value: p.r2 }] } } : {}),
        },
      })),
    }),
  )

const note = (p: Project, id: string, seat: string) =>
  p.papers.find((x) => x.id === id)?.reviews[seat]?.Note?.[0]?.value ?? null

describe('resolveClash', () => {
  // Base: nothing yet. Mine: Reviewer 1 on a and b. Disk: someone else wrote
  // Reviewer 1 on a (the clash) and Reviewer 2 on c (no clash, nothing of mine).
  const base = project([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  const mine = project([{ id: 'a', r1: 'mine' }, { id: 'b', r1: 'mine b' }, { id: 'c' }])
  const disk = project([{ id: 'a', r1: 'theirs' }, { id: 'b' }, { id: 'c', r2: 'theirs c' }])
  const clashes = ['annotations/a/reviewer-1.json']

  it("keeping mine overwrites the clashing file and nothing of theirs elsewhere", () => {
    const out = resolveClash(base, mine, disk, clashes, 'mine')
    expect(note(out, 'a', '1')).toBe('mine')
    expect(note(out, 'b', '1')).toBe('mine b')
    expect(note(out, 'c', '2')).toBe('theirs c')
  })

  it('keeping the disk drops only my edits to the clashing file', () => {
    const out = resolveClash(base, mine, disk, clashes, 'disk')
    expect(note(out, 'a', '1')).toBe('theirs')
    expect(note(out, 'b', '1')).toBe('mine b')
    expect(note(out, 'c', '2')).toBe('theirs c')
  })

  it('applies to the project file too', () => {
    const b = project([{ id: 'a' }], 'Base')
    const m = project([{ id: 'a', r1: 'mine' }], 'Mine')
    const d = project([{ id: 'a' }], 'Theirs')
    expect(resolveClash(b, m, d, ['review.json'], 'disk').title).toBe('Theirs')
    expect(resolveClash(b, m, d, ['review.json'], 'mine').title).toBe('Mine')
    expect(note(resolveClash(b, m, d, ['review.json'], 'disk'), 'a', '1')).toBe('mine')
  })

  it('keeps a paper I removed removed, and one they added', () => {
    const m = project([{ id: 'a' }, { id: 'b' }])
    const d = project([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
    const b = project([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    // I removed c; they added d. Both touch the project file, so it clashes.
    const out = resolveClash(b, m, d, ['review.json'], 'mine')
    expect(out.papers.map((p) => p.id)).toEqual(['a', 'b'])
    expect(resolveClash(b, m, d, ['review.json'], 'disk').papers.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

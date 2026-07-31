import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from './schema'
import { normalizeTree, type AnnotationValueTree } from './annotations'
import { alignedReviews, parseAlignment, type StoredAlignment } from './alignment'

const FINDINGS: AnnotationDef[] = [
  { name: 'Findings', max: null, children: [{ name: 'Claim', type: 'string' }] },
]

function finding(claim: string) {
  return { children: { Claim: [{ value: claim }] } }
}

function claims(tree: AnnotationValueTree): Array<string | null> {
  return (tree['Findings'] ?? []).map((f) => (f.children?.['Claim']?.[0]?.value ?? null) as string | null)
}

function setup(defs: AnnotationDef[], raw: Record<string, AnnotationValueTree>) {
  const schema = resolveSchema(defs)
  const reviews: Record<string, AnnotationValueTree> = {}
  for (const [r, t] of Object.entries(raw)) reviews[r] = normalizeTree(schema, t)
  return { schema, reviews }
}

describe('alignedReviews', () => {
  it('lines every reviewer up so index N is the same entry', () => {
    // R1 = (a, b, c), R2 = (d, a): four slots, "a" shared.
    const { schema, reviews } = setup(FINDINGS, {
      '1': { Findings: [finding('a'), finding('b'), finding('c')] },
      '2': { Findings: [finding('d'), finding('a')] },
    })
    const alignment: StoredAlignment = {
      Findings: [
        { members: { '1': 0, '2': 1 } },
        { members: { '1': 1 } },
        { members: { '1': 2 } },
        { members: { '2': 0 } },
      ],
    }
    const lined = alignedReviews(schema, alignment, reviews)

    expect(claims(lined['1'])).toEqual(['a', 'b', 'c', null])
    expect(claims(lined['2'])).toEqual(['a', null, null, 'd'])
  })

  it('does not touch the trees it was given', () => {
    const { schema, reviews } = setup(FINDINGS, {
      '1': { Findings: [finding('a'), finding('b')] },
      '2': { Findings: [finding('b'), finding('a')] },
    })
    const before = JSON.stringify(reviews)
    alignedReviews(schema, { Findings: [{ members: { '1': 0, '2': 1 } }, { members: { '1': 1, '2': 0 } }] }, reviews)
    expect(JSON.stringify(reviews)).toBe(before)
  })

  it('passes a node through in its own order when nothing has been matched', () => {
    // No mapping recorded — nobody has opened Consolidation on this paper.
    const { schema, reviews } = setup(FINDINGS, {
      '1': { Findings: [finding('a'), finding('b')] },
    })
    expect(claims(alignedReviews(schema, {}, reviews)['1'])).toEqual(['a', 'b'])
  })

  it('appends an entry the mapping has no slot for rather than dropping it', () => {
    // A reviewer added a third finding after the matching was recorded. It
    // must still show up: a stale mapping may misplace an entry, but it must
    // never lose one.
    const { schema, reviews } = setup(FINDINGS, {
      '1': { Findings: [finding('a'), finding('b'), finding('late')] },
    })
    const alignment: StoredAlignment = { Findings: [{ members: { '1': 0 } }, { members: { '1': 1 } }] }
    expect(claims(alignedReviews(schema, alignment, reviews)['1'])).toEqual(['a', 'b', 'late'])
  })

  it('lines up a nested repeatable within its matched parent', () => {
    const defs: AnnotationDef[] = [
      {
        name: 'Finding',
        max: null,
        children: [{ name: 'Evidence', max: null, children: [{ name: 'Metric', type: 'string' }] }],
      },
    ]
    const ev = (m: string) => ({ children: { Metric: [{ value: m }] } })
    const { schema, reviews } = setup(defs, {
      '1': { Finding: [{ children: { Evidence: [ev('precision'), ev('recall')] } }] },
      '2': { Finding: [{ children: { Evidence: [ev('recall'), ev('precision')] } }] },
    })
    const alignment: StoredAlignment = {
      Finding: [
        {
          members: { '1': 0, '2': 0 },
          children: { Evidence: [{ members: { '1': 0, '2': 1 } }, { members: { '1': 1, '2': 0 } }] },
        },
      ],
    }
    const lined = alignedReviews(schema, alignment, reviews)
    const metrics = (tree: AnnotationValueTree) =>
      (tree['Finding'][0].children?.['Evidence'] ?? []).map((e) => e.children?.['Metric']?.[0]?.value)

    expect(metrics(lined['1'])).toEqual(['precision', 'recall'])
    expect(metrics(lined['2'])).toEqual(['precision', 'recall'])
  })

  it('gives a slot this reviewer is not a member of an empty entry', () => {
    // Reviewer 1 recorded nothing; the slot belongs to reviewer 2 alone. The
    // hole is what makes `isUnanswered`/`agreedValue` read this as silence
    // rather than as an answer.
    const schema = resolveSchema(FINDINGS)
    const alignment: StoredAlignment = { Findings: [{ members: { '2': 0 } }] }
    expect(claims(alignedReviews(schema, alignment, { '1': { Findings: [] } })['1'])).toEqual([null])
  })

  it('keeps an untouched reviewer\'s own empty skeleton entry', () => {
    // `normalizeTree` seeds one empty instance so the form has something to
    // bind to. It is unmapped, so it lands after the slots — noise-free
    // (it answers nothing) and, more importantly, not silently discarded by a
    // projection that cannot tell a skeleton from a real blank entry.
    const schema = resolveSchema(FINDINGS)
    const reviews = { '1': normalizeTree(schema, {}) }
    const alignment: StoredAlignment = { Findings: [{ members: { '2': 0 } }] }
    expect(claims(alignedReviews(schema, alignment, reviews)['1'])).toEqual([null, null])
  })
})

describe('parseAlignment', () => {
  it('round-trips a well-formed mapping', () => {
    const raw = {
      Findings: [{ members: { '1': 0, '2': 1 } }, { members: { '1': 1 }, children: { Evidence: [{ members: { '1': 0 } }] } }],
    }
    expect(parseAlignment(raw)).toEqual(raw)
  })

  it('drops anything that is not a mapping at all', () => {
    expect(parseAlignment(undefined)).toEqual({})
    expect(parseAlignment(null)).toEqual({})
    expect(parseAlignment('nope')).toEqual({})
    expect(parseAlignment([1, 2])).toEqual({})
    expect(parseAlignment({ Findings: 'not a list' })).toEqual({})
  })

  it('drops an index that could not name an entry', () => {
    // A negative or fractional index would silently read as "this reviewer has
    // no entry here", which is a different claim than the file was making.
    const parsed = parseAlignment({
      Findings: [{ members: { '1': -1, '2': 1.5, '3': 'x', '4': 2 } }],
    })
    expect(parsed['Findings']).toEqual([{ members: { '4': 2 } }])
  })

  it('survives a slot that is not an object', () => {
    expect(parseAlignment({ Findings: [null, 7, { members: { '1': 0 } }] })).toEqual({
      Findings: [{ members: {} }, { members: {} }, { members: { '1': 0 } }],
    })
  })
})

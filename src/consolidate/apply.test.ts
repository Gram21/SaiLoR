import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, pruneTree, type AnnotationValueTree } from '../model/annotations'
import { alignPaper } from './align'
import { growConsolidated, toStoredAlignment } from './apply'

const FINDINGS: AnnotationDef[] = [
  {
    name: 'Findings',
    max: null,
    children: [
      { name: 'Claim', type: 'string' },
      { name: 'Evidence', type: 'string' },
    ],
  },
]

function claims(tree: AnnotationValueTree): Array<string | null> {
  return (tree['Findings'] ?? []).map((f) => (f.children?.['Claim']?.[0]?.value ?? null) as string | null)
}

function setup(defs: AnnotationDef[], raw: Record<string, AnnotationValueTree>) {
  const schema = resolveSchema(defs)
  const reviews: Record<string, AnnotationValueTree> = {}
  for (const [r, t] of Object.entries(raw)) reviews[r] = normalizeTree(schema, t)
  return { schema, reviews, consolidated: normalizeTree(schema, {}) }
}

function finding(claim: string) {
  return { children: { Claim: [{ value: claim }] } }
}

describe('growConsolidated', () => {
  it('leaves every reviewer\'s own tree exactly as they left it', () => {
    // The whole point of recording the mapping instead of reordering the data:
    // consolidation's bookkeeping is no longer written into other people's work.
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
      '2': { Findings: [finding('Gamma'), finding('Alpha')] },
    })
    const before = JSON.stringify(reviews)
    growConsolidated(schema, alignPaper(schema, reviews), consolidated)
    expect(JSON.stringify(reviews)).toBe(before)
  })

  it('grows the consolidated tree to the number of slots', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha')] },
      '2': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
    })
    expect(growConsolidated(schema, alignPaper(schema, reviews), consolidated)).toBe(true)
    expect(consolidated['Findings']).toHaveLength(3)
  })

  it('covers the union when the reviewers recorded different things', () => {
    // R1 = (a, b, c), R2 = (d, a). One shared entry, three that only one of
    // them has — so the consolidator is handed four, not three.
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('a'), finding('b'), finding('c')] },
      '2': { Findings: [finding('d'), finding('a')] },
    })
    growConsolidated(schema, alignPaper(schema, reviews), consolidated)

    expect(consolidated['Findings']).toHaveLength(4)
    // ...and neither reviewer's stored list gained a phantom entry for it.
    expect(claims(pruneTree(schema, reviews['1']))).toEqual(['a', 'b', 'c'])
    expect(claims(pruneTree(schema, reviews['2']))).toEqual(['d', 'a'])
  })

  it('never shrinks the consolidated tree below what the consolidator built', () => {
    const { schema, reviews } = setup(FINDINGS, { '1': { Findings: [finding('Alpha')] } })
    const consolidated = normalizeTree(resolveSchema(FINDINGS), {
      Findings: [finding('Alpha'), finding('Mine'), finding('Also mine')],
    })
    growConsolidated(schema, alignPaper(schema, reviews), consolidated)
    expect(claims(consolidated)).toEqual(['Alpha', 'Mine', 'Also mine'])
  })

  it('reports no change when the tree already fits', () => {
    // Opening the consolidation view must not dirty a project it did not alter.
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta')] },
      '2': { Findings: [finding('Alpha'), finding('Beta')] },
    })
    expect(growConsolidated(schema, alignPaper(schema, reviews), consolidated)).toBe(true)
    expect(growConsolidated(schema, alignPaper(schema, reviews), consolidated)).toBe(false)
  })

  it('respects a node\'s max when growing', () => {
    const capped: AnnotationDef[] = [{ name: 'Findings', type: 'string', max: 2 }]
    const { schema, reviews, consolidated } = setup(capped, {
      '1': { Findings: [{ value: 'a' }, { value: 'b' }] },
      '2': { Findings: [{ value: 'b' }, { value: 'a' }] },
    })
    growConsolidated(schema, alignPaper(schema, reviews), consolidated)
    expect(consolidated['Findings']).toHaveLength(2)
  })

  it('grows a nested repeatable inside its matched parent', () => {
    const defs: AnnotationDef[] = [
      {
        name: 'Finding',
        max: null,
        children: [
          { name: 'Claim', type: 'string' },
          { name: 'Evidence', max: null, children: [{ name: 'Metric', type: 'string' }] },
        ],
      },
    ]
    const ev = (m: string) => ({ children: { Metric: [{ value: m }] } })
    const { schema, reviews, consolidated } = setup(defs, {
      '1': {
        Finding: [
          { children: { Claim: [{ value: 'Alpha' }], Evidence: [ev('precision'), ev('recall')] } },
          { children: { Claim: [{ value: 'Beta' }], Evidence: [ev('f1')] } },
        ],
      },
      '2': {
        Finding: [
          { children: { Claim: [{ value: 'Beta' }], Evidence: [ev('f1')] } },
          { children: { Claim: [{ value: 'Alpha' }], Evidence: [ev('recall'), ev('precision')] } },
        ],
      },
    })
    growConsolidated(schema, alignPaper(schema, reviews), consolidated)

    expect(consolidated['Finding']).toHaveLength(2)
    // The "Alpha" slot is the one holding two pieces of evidence.
    const evidenceCounts = consolidated['Finding']
      .map((f) => (f.children?.['Evidence'] ?? []).length)
      .sort()
    expect(evidenceCounts).toEqual([1, 2])
  })

  it('is idempotent', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta')] },
      '2': { Findings: [finding('Beta'), finding('Alpha')] },
    })
    growConsolidated(schema, alignPaper(schema, reviews), consolidated)
    const after = JSON.stringify(consolidated)
    growConsolidated(schema, alignPaper(schema, reviews), consolidated)
    expect(JSON.stringify(consolidated)).toBe(after)
  })
})

describe('toStoredAlignment', () => {
  it('keeps the members and drops the derived scores', () => {
    const { schema, reviews } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta')] },
      '2': { Findings: [finding('Beta')] },
    })
    const stored = toStoredAlignment(alignPaper(schema, reviews))

    expect(stored['Findings']).toEqual([{ members: { '1': 0 } }, { members: { '1': 1, '2': 0 } }])
    // No `agreement`/`evidence`/`counts` — they are re-derived, never stored.
    expect(JSON.stringify(stored)).not.toContain('agreement')
    expect(JSON.stringify(stored)).not.toContain('counts')
  })

  it('nests a child mapping under the slot it belongs to', () => {
    const defs: AnnotationDef[] = [
      {
        name: 'Finding',
        max: null,
        children: [
          { name: 'Claim', type: 'string' },
          { name: 'Evidence', max: null, children: [{ name: 'Metric', type: 'string' }] },
        ],
      },
    ]
    const ev = (m: string) => ({ children: { Metric: [{ value: m }] } })
    const { schema, reviews } = setup(defs, {
      '1': { Finding: [{ children: { Claim: [{ value: 'Alpha' }], Evidence: [ev('precision'), ev('recall')] } }] },
      '2': { Finding: [{ children: { Claim: [{ value: 'Alpha' }], Evidence: [ev('recall'), ev('precision')] } }] },
    })
    const stored = toStoredAlignment(alignPaper(schema, reviews))

    const slot = stored['Finding'][0]
    expect(slot.members).toEqual({ '1': 0, '2': 0 })
    // Reviewer 2 listed the two metrics the other way round.
    expect(slot.children?.['Evidence']).toEqual([
      { members: { '1': 0, '2': 1 } },
      { members: { '1': 1, '2': 0 } },
    ])
  })
})

import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, pruneTree, type AnnotationValueTree } from '../model/annotations'
import { alignPaper } from './align'
import { applyAlignment, remapAlignedPath } from './apply'

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

describe('applyAlignment', () => {
  it('lines the reviewers up so the same entry sits at the same index', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
      '2': { Findings: [finding('Gamma'), finding('Alpha'), finding('Beta')] },
    })
    const changed = applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)

    expect(changed).toBe(true)
    expect(claims(reviews['1'])).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(claims(reviews['2'])).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('grows the consolidated tree to the largest reviewer count', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha')] },
      '2': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
    })
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    expect(consolidated['Findings']).toHaveLength(3)
  })

  it('never shrinks the consolidated tree below what the consolidator built', () => {
    const { schema, reviews } = setup(FINDINGS, { '1': { Findings: [finding('Alpha')] } })
    const consolidated = normalizeTree(
      resolveSchema(FINDINGS),
      { Findings: [finding('Alpha'), finding('Mine'), finding('Also mine')] },
    )
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    expect(claims(consolidated)).toEqual(['Alpha', 'Mine', 'Also mine'])
  })

  it('reports no change when the data already matches the alignment', () => {
    // Opening the consolidation view must not dirty a project it did not alter.
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta')] },
      '2': { Findings: [finding('Alpha'), finding('Beta')] },
    })
    const alignment = alignPaper(schema, reviews)
    expect(applyAlignment(schema, alignment, reviews, consolidated)).toBe(true) // grows consolidated
    expect(applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)).toBe(false)
  })

  it('leaves a gap where a reviewer has no entry for a slot', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
      '2': { Findings: [finding('Gamma')] },
    })
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    // Reviewer 2 only recorded Gamma, which everyone else lists third — so it is
    // third for them too, and the first two slots stand empty.
    expect(claims(reviews['2'])).toEqual([null, null, 'Gamma'])
  })

  it('survives a save and reload with the alignment intact', () => {
    // The whole persistence claim in one test: prune (as `save` does), reload
    // (as `normalizeTree` does), and the indices must still mean what they did.
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
      '2': { Findings: [finding('Gamma')] },
    })
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)

    const roundTrip = (tree: AnnotationValueTree) =>
      normalizeTree(schema, JSON.parse(JSON.stringify(pruneTree(schema, tree))))

    expect(claims(roundTrip(reviews['1']))).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(claims(roundTrip(reviews['2']))).toEqual([null, null, 'Gamma'])
  })

  it('drops the trailing empties a reviewer never filled', () => {
    // The flip side: gaps are kept because they carry meaning, but an entry
    // nobody has anything for is still just clutter.
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha')] },
      '2': { Findings: [finding('Alpha')] },
    })
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    reviews['1']['Findings'].push({ children: { Claim: [{ value: null }] } })
    expect(pruneTree(schema, reviews['1'])['Findings']).toHaveLength(1)
  })

  it('reorders a nested group inside its matched parent', () => {
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
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)

    const metrics = (tree: AnnotationValueTree, findingIndex: number) =>
      (tree['Finding'][findingIndex].children?.['Evidence'] ?? []).map(
        (e) => e.children?.['Metric']?.[0]?.value,
      )

    // Parents lined up, and the nested Evidence lined up within them.
    expect(metrics(reviews['1'], 0)).toEqual(['precision', 'recall'])
    expect(metrics(reviews['2'], 0)).toEqual(['precision', 'recall'])
    expect(consolidated['Finding']).toHaveLength(2)
    expect(consolidated['Finding'][0].children?.['Evidence']).toHaveLength(2)
  })

  it('respects a node\'s max when growing', () => {
    const capped: AnnotationDef[] = [{ name: 'Findings', type: 'string', max: 2 }]
    const { schema, reviews, consolidated } = setup(capped, {
      '1': { Findings: [{ value: 'a' }, { value: 'b' }] },
      '2': { Findings: [{ value: 'b' }, { value: 'a' }] },
    })
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    expect(consolidated['Findings']).toHaveLength(2)
  })

  it('keeps every entry it was given', () => {
    // Whatever the matcher decides, no reviewer's work may vanish.
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
      '2': { Findings: [finding('Zeta'), finding('Alpha')] },
    })
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    for (const reviewer of ['1', '2']) {
      const present = claims(reviews[reviewer]).filter(Boolean).sort()
      expect(present).toEqual(
        reviewer === '1' ? ['Alpha', 'Beta', 'Gamma'] : ['Alpha', 'Zeta'],
      )
    }
  })

  it('is idempotent', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta')] },
      '2': { Findings: [finding('Beta'), finding('Alpha')] },
    })
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    const after = JSON.stringify(reviews)
    applyAlignment(schema, alignPaper(schema, reviews), reviews, consolidated)
    expect(JSON.stringify(reviews)).toBe(after)
  })
})

describe('remapAlignedPath', () => {
  it('translates a reviewer-local index to its new slot, matching what applyAlignment actually did', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
      '2': { Findings: [finding('Gamma'), finding('Alpha'), finding('Beta')] },
    })
    const alignment = alignPaper(schema, reviews)
    applyAlignment(schema, alignment, reviews, consolidated)

    // Reviewer 2's original entry 0 ('Gamma') is the one this remaps — find
    // where it actually landed, rather than hand-picking an index.
    const newIndex = claims(reviews['2']).indexOf('Gamma')

    expect(remapAlignedPath(alignment, '2', [{ name: 'Findings', index: 0 }])).toEqual([
      { name: 'Findings', index: newIndex },
    ])
  })

  it('remaps a nested repeatable child within its matched parent slot', () => {
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
    const alignment = alignPaper(schema, reviews)
    applyAlignment(schema, alignment, reviews, consolidated)

    // Reviewer 2's Finding[1]/Evidence[0] was 'recall', which lands at
    // Finding[0]/Evidence[1] after alignment.
    const remapped = remapAlignedPath(alignment, '2', [
      { name: 'Finding', index: 1 },
      { name: 'Evidence', index: 0 },
    ])
    expect(remapped).toEqual([
      { name: 'Finding', index: 0 },
      { name: 'Evidence', index: 1 },
    ])
  })

  it('remaps the repeatable index and keeps a trailing leaf field segment as-is', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta'), finding('Gamma')] },
      '2': { Findings: [finding('Gamma'), finding('Alpha'), finding('Beta')] },
    })
    const alignment = alignPaper(schema, reviews)
    applyAlignment(schema, alignment, reviews, consolidated)
    const newIndex = claims(reviews['2']).indexOf('Gamma')

    const remapped = remapAlignedPath(alignment, '2', [
      { name: 'Findings', index: 0 },
      { name: 'Claim', index: 0 },
    ])
    expect(remapped).toEqual([
      { name: 'Findings', index: newIndex },
      { name: 'Claim', index: 0 },
    ])
  })

  it('leaves an unknown node name unchanged', () => {
    const { schema, reviews, consolidated } = setup(FINDINGS, {
      '1': { Findings: [finding('Alpha'), finding('Beta')] },
      '2': { Findings: [finding('Beta'), finding('Alpha')] },
    })
    const alignment = alignPaper(schema, reviews)
    applyAlignment(schema, alignment, reviews, consolidated)

    expect(remapAlignedPath(alignment, '2', [{ name: 'NoSuchNode', index: 0 }])).toEqual([
      { name: 'NoSuchNode', index: 0 },
    ])
  })
})

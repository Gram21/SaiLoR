import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import { alignPaper, type NodeAlignment } from './align'

/** Resolve a schema and normalise each reviewer's raw tree against it. */
function setup(defs: AnnotationDef[], raw: Record<string, AnnotationValueTree>) {
  const schema = resolveSchema(defs)
  const reviews: Record<string, AnnotationValueTree> = {}
  for (const [reviewer, tree] of Object.entries(raw)) {
    reviews[reviewer] = normalizeTree(schema, tree)
  }
  return { schema, reviews }
}

/** "reviewer 1's entry N sits in slot S" → a readable [slot, index] list. */
function slotsOf(alignment: NodeAlignment, reviewer: string): number[] {
  return alignment.slots.map((s) => s.members[reviewer] ?? -1)
}

describe('alignPaper', () => {
  const findings: AnnotationDef[] = [
    {
      name: 'Findings',
      max: null,
      children: [
        { name: 'Claim', type: 'string' },
        { name: 'Evidence', type: 'string' },
      ],
    },
  ]

  it('matches entries the reviewers recorded in a different order', () => {
    // The core case: same three findings, listed back-to-front by Reviewer 2.
    const { schema, reviews } = setup(findings, {
      '1': {
        Findings: [
          { children: { Claim: [{ value: 'Tests reduce defects' }], Evidence: [{ value: 'RQ1' }] } },
          { children: { Claim: [{ value: 'Reviews find bugs' }], Evidence: [{ value: 'RQ2' }] } },
          { children: { Claim: [{ value: 'CI speeds delivery' }], Evidence: [{ value: 'RQ3' }] } },
        ],
      },
      '2': {
        Findings: [
          { children: { Claim: [{ value: 'CI speeds delivery' }], Evidence: [{ value: 'RQ3' }] } },
          { children: { Claim: [{ value: 'Reviews find bugs' }], Evidence: [{ value: 'RQ2' }] } },
          { children: { Claim: [{ value: 'Tests reduce defects' }], Evidence: [{ value: 'RQ1' }] } },
        ],
      },
    })
    const alignment = alignPaper(schema, reviews)['Findings']

    expect(slotsOf(alignment, '1')).toEqual([0, 1, 2])
    expect(slotsOf(alignment, '2')).toEqual([2, 1, 0])
    // Every slot pairs identical text, so every slot is in full agreement.
    expect(alignment.slots.map((s) => s.agreement)).toEqual([1, 1, 1])
  })

  it('matches through wording differences rather than demanding identical text', () => {
    const { schema, reviews } = setup(findings, {
      '1': { Findings: [{ children: { Claim: [{ value: 'Unit tests reduce defects' }] } }] },
      '2': { Findings: [{ children: { Claim: [{ value: 'unit tests reduce defect' }] } }] },
    })
    const alignment = alignPaper(schema, reviews)['Findings']
    expect(alignment.slots[0].members).toEqual({ '1': 0, '2': 0 })
    expect(alignment.slots[0].agreement).toBeGreaterThan(0.8)
  })

  it('gives the entry that agrees on more fields priority', () => {
    // Both candidates agree on Claim. Only the second also agrees on Evidence,
    // so it must win the slot — the "more matching fields ranks higher" rule.
    const { schema, reviews } = setup(findings, {
      '1': {
        Findings: [{ children: { Claim: [{ value: 'Shared claim' }], Evidence: [{ value: 'Table 4' }] } }],
      },
      '2': {
        Findings: [
          { children: { Claim: [{ value: 'Shared claim' }], Evidence: [{ value: 'Nothing alike' }] } },
          { children: { Claim: [{ value: 'Shared claim' }], Evidence: [{ value: 'Table 4' }] } },
        ],
      },
    })
    const alignment = alignPaper(schema, reviews)['Findings']
    const slotWithR1 = alignment.slots.find((s) => s.members['1'] !== undefined)
    expect(slotWithR1?.members['2']).toBe(1)
  })

  it('keeps a group and its subfields in the same match', () => {
    // Reviewer 2 swapped the two studies. If matching were done per field
    // instead of per group, Method could pair with one study while Population
    // paired with the other. It must not: the group decides, the children follow.
    const defs: AnnotationDef[] = [
      {
        name: 'Study',
        max: null,
        children: [
          { name: 'Method', type: 'string' },
          { name: 'Population', type: 'string' },
        ],
      },
    ]
    const { schema, reviews } = setup(defs, {
      '1': {
        Study: [
          { children: { Method: [{ value: 'Survey' }], Population: [{ value: 'Students' }] } },
          { children: { Method: [{ value: 'Interview' }], Population: [{ value: 'Engineers' }] } },
        ],
      },
      '2': {
        Study: [
          { children: { Method: [{ value: 'Interview' }], Population: [{ value: 'Engineers' }] } },
          { children: { Method: [{ value: 'Survey' }], Population: [{ value: 'Students' }] } },
        ],
      },
    })
    const alignment = alignPaper(schema, reviews)['Study']
    expect(slotsOf(alignment, '2')).toEqual([1, 0])
    for (const slot of alignment.slots) expect(slot.agreement).toBe(1)
  })

  it('matches nested repeated groups only inside their matched parent', () => {
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
    const { schema, reviews } = setup(defs, {
      '1': {
        Finding: [
          {
            children: {
              Claim: [{ value: 'Alpha' }],
              Evidence: [
                { children: { Metric: [{ value: 'precision' }] } },
                { children: { Metric: [{ value: 'recall' }] } },
              ],
            },
          },
          { children: { Claim: [{ value: 'Beta' }], Evidence: [{ children: { Metric: [{ value: 'f1' }] } }] } },
        ],
      },
      '2': {
        Finding: [
          { children: { Claim: [{ value: 'Beta' }], Evidence: [{ children: { Metric: [{ value: 'f1' }] } }] } },
          {
            children: {
              Claim: [{ value: 'Alpha' }],
              Evidence: [
                { children: { Metric: [{ value: 'recall' }] } },
                { children: { Metric: [{ value: 'precision' }] } },
              ],
            },
          },
        ],
      },
    })
    const alignment = alignPaper(schema, reviews)['Finding']
    // Parents swapped...
    expect(slotsOf(alignment, '2')).toEqual([1, 0])

    // ...and inside the "Alpha" slot the nested Evidence swapped too, matched
    // against its own parent's entries rather than across findings.
    const alphaSlot = alignment.slots[0]
    const evidence = alphaSlot.children['Evidence']
    expect(slotsOf(evidence, '1')).toEqual([0, 1])
    expect(slotsOf(evidence, '2')).toEqual([1, 0])
  })

  it('opens as many slots as the most prolific reviewer used', () => {
    const { schema, reviews } = setup(findings, {
      '1': { Findings: [{ children: { Claim: [{ value: 'One' }] } }] },
      '2': {
        Findings: [
          { children: { Claim: [{ value: 'One' }] } },
          { children: { Claim: [{ value: 'Two' }] } },
          { children: { Claim: [{ value: 'Three' }] } },
        ],
      },
    })
    const alignment = alignPaper(schema, reviews)['Findings']
    expect(alignment.slots).toHaveLength(3)
    expect(alignment.counts).toEqual({ '1': 1, '2': 3 })
    // Reviewer 1's single entry lands with its counterpart, not just in slot 0.
    const shared = alignment.slots.find((s) => s.members['1'] !== undefined)
    expect(shared?.members['2']).toBe(0)
  })

  it('folds a third reviewer onto the slots the others established', () => {
    const { schema, reviews } = setup(findings, {
      '1': {
        Findings: [
          { children: { Claim: [{ value: 'Alpha' }] } },
          { children: { Claim: [{ value: 'Beta' }] } },
        ],
      },
      '2': {
        Findings: [
          { children: { Claim: [{ value: 'Beta' }] } },
          { children: { Claim: [{ value: 'Alpha' }] } },
        ],
      },
      '3': { Findings: [{ children: { Claim: [{ value: 'Beta' }] } }] },
    })
    const alignment = alignPaper(schema, reviews)['Findings']
    const betaSlot = alignment.slots.find((s) => s.members['3'] !== undefined)
    // Whichever slot Beta ended up in, all three reviewers' Betas are in it.
    expect(betaSlot).toBeDefined()
    expect(betaSlot!.members['1']).toBe(1)
    expect(betaSlot!.members['2']).toBe(0)
  })

  it('leaves the order alone when there is nothing to go on', () => {
    // Both reviewers left everything blank: no evidence in either direction, so
    // shuffling the entries would be pure noise.
    const { schema, reviews } = setup(findings, {
      '1': { Findings: [{}, {}, {}] },
      '2': { Findings: [{}, {}, {}] },
    })
    const alignment = alignPaper(schema, reviews)['Findings']
    expect(slotsOf(alignment, '1')).toEqual([0, 1, 2])
    expect(slotsOf(alignment, '2')).toEqual([0, 1, 2])
    expect(alignment.slots.every((s) => s.evidence === 0)).toBe(true)
  })

  it('does not let an enum near-match: High is not Low', () => {
    // "High"/"Low" overlap as characters and mean the opposite. An enum is a set
    // of labels, so only an exact label counts.
    const defs: AnnotationDef[] = [
      {
        name: 'Risk',
        max: null,
        children: [{ name: 'Level', type: 'string', options: ['High', 'Low'] }],
      },
    ]
    const { schema, reviews } = setup(defs, {
      '1': { Risk: [{ children: { Level: [{ value: 'High' }] } }] },
      '2': { Risk: [{ children: { Level: [{ value: 'Low' }] } }] },
    })
    const alignment = alignPaper(schema, reviews)['Risk']
    expect(alignment.slots[0].agreement).toBe(0)
  })

  it('does not count a field only one reviewer answered against the match', () => {
    const { schema, reviews } = setup(findings, {
      '1': { Findings: [{ children: { Claim: [{ value: 'Same' }], Evidence: [{ value: 'Table 1' }] } }] },
      '2': { Findings: [{ children: { Claim: [{ value: 'Same' }] } }] },
    })
    const alignment = alignPaper(schema, reviews)['Findings']
    // Claim agrees; the Evidence only Reviewer 1 filled abstains rather than
    // halving the score.
    expect(alignment.slots[0].agreement).toBe(1)
  })

  it('is deterministic', () => {
    const build = () =>
      setup(findings, {
        '1': {
          Findings: [
            { children: { Claim: [{ value: 'Alpha' }] } },
            { children: { Claim: [{ value: 'Beta' }] } },
          ],
        },
        '2': {
          Findings: [
            { children: { Claim: [{ value: 'Beta' }] } },
            { children: { Claim: [{ value: 'Alpha' }] } },
          ],
        },
      })
    const first = build()
    const second = build()
    expect(JSON.stringify(alignPaper(first.schema, first.reviews))).toBe(
      JSON.stringify(alignPaper(second.schema, second.reviews)),
    )
  })

  it('handles a reviewer who recorded nothing at all', () => {
    const { schema, reviews } = setup(findings, {
      '1': { Findings: [{ children: { Claim: [{ value: 'Alpha' }] } }] },
      '2': {},
    })
    const alignment = alignPaper(schema, reviews)['Findings']
    expect(alignment.slots).toHaveLength(1)
    expect(alignment.slots[0].members['1']).toBe(0)
  })
})

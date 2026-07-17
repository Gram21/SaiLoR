import { describe, it, expect } from 'vitest'
import type { ResolvedDef } from './schema'
import type { AnnotationValueTree } from './annotations'
import type { Paper, Project } from './project'
import { validatePaper, validateProject, type UnannotatedPaper, type ValidationIssue } from './validate'

// ---------------------------------------------------------------------------
// Builders. ResolvedDef is constructed directly (rather than via resolveSchema)
// so these tests pin the validator's behaviour, not the resolver's defaults.
// ---------------------------------------------------------------------------

function def(partial: Partial<ResolvedDef> & { name: string }): ResolvedDef {
  return {
    id: partial.name,
    min: 1,
    max: 1,
    required: false,
    children: [],
    ...partial,
  }
}

function paper(annotations: AnnotationValueTree, over: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    title: 'Paper One',
    authors: [],
    pdf: 'pdfs/one.pdf',
    annotations,
    reviews: {},
    aiUsage: [],
    equal: [],
    extra: {},
    ...over,
  }
}

function kinds(issues: ValidationIssue[]): string[] {
  return issues.map((i) => i.kind)
}

const sampleSchema: ResolvedDef[] = [
  def({ name: 'Relevant', type: 'boolean', required: true }),
  def({ name: 'Study Type', type: 'string', options: ['RCT', 'Survey', 'Case Study'] }),
  def({ name: 'Year', type: 'number', required: true }),
  def({
    name: 'Findings',
    min: 1,
    max: null,
    children: [
      def({ name: 'Claim', type: 'string', required: true }),
      def({
        name: 'Evidence',
        min: 1,
        max: 2,
        children: [def({ name: 'Metric', type: 'string', required: true })],
      }),
    ],
  }),
]

function validSample(): AnnotationValueTree {
  return {
    Relevant: [{ value: true }],
    'Study Type': [{ value: 'RCT' }],
    Year: [{ value: 2021 }],
    Findings: [
      {
        children: {
          Claim: [{ value: 'X improves Y' }],
          Evidence: [{ children: { Metric: [{ value: 'accuracy' }] } }],
        },
      },
    ],
  }
}

describe('validatePaper: valid input', () => {
  it('reports nothing for a fully valid paper', () => {
    expect(validatePaper(sampleSchema, paper(validSample()))).toEqual([])
  })
})

describe('required', () => {
  it('flags an empty string and a null number', () => {
    const schema = [
      def({ name: 'Claim', type: 'string', required: true }),
      def({ name: 'Year', type: 'number', required: true }),
    ]
    const issues = validatePaper(
      schema,
      paper({ Claim: [{ value: '   ' }], Year: [{ value: null }] }),
    )
    expect(kinds(issues)).toEqual(['required', 'required'])
    expect(issues[0].message).toBe('"Claim" is required but empty.')
    expect(issues[0].path).toBe('Claim')
  })

  it('does not flag a required field that is filled', () => {
    const schema = [def({ name: 'Claim', type: 'string', required: true })]
    expect(validatePaper(schema, paper({ Claim: [{ value: 'something' }] }))).toEqual([])
  })

  it('does not flag an empty value on a non-required field', () => {
    const schema = [def({ name: 'Claim', type: 'string' })]
    expect(validatePaper(schema, paper({ Claim: [{ value: null }] }))).toEqual([])
  })

  // The important case: an unchecked box is a real answer (false), so a boolean
  // is never "empty" — not when it is false, and not when it is missing.
  it('NEVER flags a required boolean, whether false or null', () => {
    const schema = [
      def({ name: 'Relevant', type: 'boolean', required: true }),
      def({ name: 'Screened', type: 'boolean', required: true }),
    ]
    const issues = validatePaper(
      schema,
      paper({ Relevant: [{ value: false }], Screened: [{ value: null }] }),
    )
    expect(issues).toEqual([])
  })

  it('treats 0 and "0" as real values, not as empty', () => {
    const schema = [
      def({ name: 'Count', type: 'number', required: true }),
      def({ name: 'Label', type: 'string', required: true }),
    ]
    const issues = validatePaper(schema, paper({ Count: [{ value: 0 }], Label: [{ value: '0' }] }))
    expect(issues).toEqual([])
  })
})

describe('type', () => {
  it('flags a string held in a number field', () => {
    const schema = [def({ name: 'Year', type: 'number' })]
    const issues = validatePaper(schema, paper({ Year: [{ value: '2021' as never }] }))
    expect(kinds(issues)).toEqual(['type'])
    expect(issues[0].message).toBe('"Year" should be a number but holds a string ("2021").')
  })

  it('flags NaN in a number field', () => {
    const schema = [def({ name: 'Year', type: 'number' })]
    const issues = validatePaper(schema, paper({ Year: [{ value: NaN }] }))
    expect(kinds(issues)).toEqual(['type'])
    expect(issues[0].message).toContain('NaN')
  })

  it('flags a number held in a string field', () => {
    const schema = [def({ name: 'Claim', type: 'string' })]
    const issues = validatePaper(schema, paper({ Claim: [{ value: 42 as never }] }))
    expect(kinds(issues)).toEqual(['type'])
    expect(issues[0].message).toBe('"Claim" should be a string but holds a number (42).')
  })

  it('flags a string held in a boolean field', () => {
    const schema = [def({ name: 'Relevant', type: 'boolean' })]
    const issues = validatePaper(schema, paper({ Relevant: [{ value: 'yes' as never }] }))
    expect(kinds(issues)).toEqual(['type'])
    expect(issues[0].message).toBe('"Relevant" should be a boolean but holds a string ("yes").')
  })

  it('does not double-report a mistyped required field', () => {
    const schema = [def({ name: 'Year', type: 'number', required: true })]
    const issues = validatePaper(schema, paper({ Year: [{ value: 'x' as never }] }))
    expect(kinds(issues)).toEqual(['type'])
  })
})

describe('enum', () => {
  it('flags a value outside options and lists the allowed values', () => {
    const schema = [def({ name: 'Study Type', type: 'string', options: ['RCT', 'Survey'] })]
    const issues = validatePaper(schema, paper({ 'Study Type': [{ value: 'Vibes' }] }))
    expect(kinds(issues)).toEqual(['enum'])
    expect(issues[0].message).toContain('RCT, Survey')
    expect(issues[0].message).toContain('"Vibes"')
  })

  it('accepts a value that is in options, and an empty optional enum', () => {
    const schema = [def({ name: 'Study Type', type: 'string', options: ['RCT', 'Survey'] })]
    expect(validatePaper(schema, paper({ 'Study Type': [{ value: 'RCT' }] }))).toEqual([])
    expect(validatePaper(schema, paper({ 'Study Type': [{ value: null }] }))).toEqual([])
  })

  it('truncates a very long option list', () => {
    const options = Array.from({ length: 12 }, (_, i) => `opt${i + 1}`)
    const schema = [def({ name: 'Tag', type: 'string', options })]
    const issues = validatePaper(schema, paper({ Tag: [{ value: 'nope' }] }))
    expect(issues[0].message).toContain('+4 more')
    expect(issues[0].message).not.toContain('opt12')
  })
})

describe('cardinality', () => {
  it('flags too few instances (including a missing key)', () => {
    const schema = [def({ name: 'Findings', min: 1, max: null, children: [def({ name: 'Claim', type: 'string' })] })]
    const issues = validatePaper(schema, paper({}))
    expect(kinds(issues)).toEqual(['cardinality'])
    expect(issues[0].message).toBe('"Findings" needs at least 1 entry but has 0.')
  })

  it('flags too many instances', () => {
    const schema = [def({ name: 'Tag', type: 'string', min: 0, max: 2 })]
    const issues = validatePaper(
      schema,
      paper({ Tag: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }),
    )
    expect(kinds(issues)).toEqual(['cardinality'])
    expect(issues[0].message).toBe('"Tag" allows at most 2 entries but has 3.')
  })

  it('accepts an unbounded node with many instances', () => {
    const schema = [def({ name: 'Tag', type: 'string', min: 1, max: null })]
    const issues = validatePaper(
      schema,
      paper({ Tag: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }),
    )
    expect(issues).toEqual([])
  })

  it('still walks the instances that are present when the count is wrong', () => {
    const schema = [def({ name: 'Tag', type: 'string', required: true, min: 3, max: null })]
    const issues = validatePaper(schema, paper({ Tag: [{ value: '' }] }))
    expect(kinds(issues)).toEqual(['cardinality', 'required'])
  })
})

describe('paths', () => {
  it('numbers a segment only when the node actually repeats', () => {
    const tree = validSample()
    tree.Findings = [
      {
        children: {
          Claim: [{ value: 'first' }],
          Evidence: [{ children: { Metric: [{ value: '' }] } }],
        },
      },
      {
        children: {
          Claim: [{ value: '' }],
          Evidence: [
            { children: { Metric: [{ value: 'a' }] } },
            { children: { Metric: [{ value: '' }] } },
          ],
        },
      },
    ]
    const paths = validatePaper(sampleSchema, paper(tree)).map((i) => i.path)
    expect(paths).toEqual([
      'Findings #1 › Evidence › Metric',
      'Findings #2 › Claim',
      'Findings #2 › Evidence #2 › Metric',
    ])
  })

  it('uses a bare name for non-repeating fields', () => {
    const schema = [def({ name: 'Relevant', type: 'string', required: true })]
    const issues = validatePaper(schema, paper({ Relevant: [{ value: '' }] }))
    expect(issues[0].path).toBe('Relevant')
  })

  it('validates a node that has both a value and children', () => {
    const schema = [
      def({
        name: 'Outcome',
        type: 'string',
        required: true,
        children: [def({ name: 'Metric', type: 'number', required: true })],
      }),
    ]
    const issues = validatePaper(
      schema,
      paper({ Outcome: [{ value: '', children: { Metric: [{ value: null }] } }] }),
    )
    expect(issues.map((i) => i.path)).toEqual(['Outcome', 'Outcome › Metric'])
    expect(kinds(issues)).toEqual(['required', 'required'])
  })
})

describe('malformed trees', () => {
  it('reports rather than throws when instances are not an array', () => {
    const schema = [def({ name: 'Findings', children: [def({ name: 'Claim', type: 'string' })] })]
    const issues = validatePaper(
      schema,
      paper({ Findings: { value: 'oops' } as never }),
    )
    expect(kinds(issues)).toEqual(['type'])
    expect(issues[0].message).toContain('list of entries')
  })

  it('reports rather than throws when an instance is not an object', () => {
    const schema = [def({ name: 'Tag', type: 'string', min: 1, max: null })]
    const issues = validatePaper(schema, paper({ Tag: ['oops' as never] }))
    expect(kinds(issues)).toEqual(['type'])
  })

  it('survives a null annotations tree and null children', () => {
    const schema = [def({ name: 'Findings', children: [def({ name: 'Claim', type: 'string', required: true })] })]
    expect(() => validatePaper(schema, paper(null as never))).not.toThrow()
    const issues = validatePaper(schema, paper({ Findings: [{ children: null as never }] }))
    expect(kinds(issues)).toEqual(['cardinality'])
  })
})

describe('validateProject', () => {
  function project(papers: Paper[]): Project {
    return {
      version: 1,
      schema: sampleSchema,
      aiEnabled: true,
      reviewers: 1,
      reviewerIdentities: {},
      papers,
      screening: null,
      extra: {},
    }
  }

  function unannotatedIds(list: UnannotatedPaper[]): string[] {
    return list.map((p) => p.paperId)
  }

  it('aggregates across papers in order and tags each issue with the paper', () => {
    const bad = validSample()
    bad.Year = [{ value: null }]
    const worse = validSample()
    worse.Findings = [{ children: { Claim: [{ value: '' }], Evidence: [{ children: { Metric: [{ value: 'm' }] } }] } }]

    const { issues, unannotated } = validateProject(
      project([
        paper(validSample(), { id: 'ok', title: 'Fine Paper' }),
        paper(bad, { id: 'p2', title: 'Missing Year' }),
        paper(worse, { id: 'p3', title: 'Missing Claim' }),
      ]),
    )

    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({ paperId: 'p2', paperTitle: 'Missing Year', kind: 'required' })
    expect(issues[1]).toMatchObject({
      paperId: 'p3',
      paperTitle: 'Missing Claim',
      kind: 'required',
      path: 'Findings › Claim',
    })
    // All three papers have at least one field filled in, so none are skipped.
    expect(unannotated).toEqual([])
  })

  it('returns nothing for a valid project', () => {
    expect(validateProject(project([paper(validSample())]))).toEqual({ issues: [], unannotated: [] })
  })

  it('never throws on a garbage project', () => {
    expect(() => validateProject({} as never)).not.toThrow()
    expect(validateProject({} as never)).toEqual({ issues: [], unannotated: [] })
    expect(() => validateProject({ schema: null, papers: 'nope' } as never)).not.toThrow()
  })

  /**
   * The shape the real app loads an untouched paper as: every node scaffolded
   * to its `min` instance count, every value at its type's blank default
   * (`null` for string/number, `false` for boolean) — never an absent key.
   * `hasAnnotations` (annotations.ts) is what decides "empty" here, and it
   * disagrees with `isEmptyValue` on booleans on purpose (see its own
   * comment): an untouched `false` does not count as an answer, only an
   * explicit `true` does — matching the paper-list sidebar's "annotated" dot,
   * which this skip is meant to agree with, not reinvent.
   */
  function scaffold(): AnnotationValueTree {
    return {
      Relevant: [{ value: false }],
      'Study Type': [{ value: null }],
      Year: [{ value: null }],
      Findings: [
        {
          children: {
            Claim: [{ value: null }],
            Evidence: [{ children: { Metric: [{ value: null }] } }],
          },
        },
      ],
    }
  }

  // The whole point of the skip: a paper nobody has touched yet fails every
  // required field for the same reason it fails all of them — it isn't
  // started — so validating it says nothing a reviewer doesn't already know.
  describe('papers with no annotations at all are skipped, not validated', () => {
    it('skips a paper whose annotations are entirely empty', () => {
      const { issues, unannotated } = validateProject(
        project([paper({}, { id: 'untouched', title: 'Untouched Paper' })]),
      )
      expect(issues).toEqual([])
      expect(unannotated).toEqual([{ paperId: 'untouched', paperTitle: 'Untouched Paper' }])
    })

    it('skips a paper scaffolded to its blank defaults, same as an empty one', () => {
      const { unannotated } = validateProject(project([paper(scaffold(), { id: 'p1' })]))
      expect(unannotated).toEqual([{ paperId: 'p1', paperTitle: 'Paper One' }])
    })

    it('validates a paper the moment even one field is filled — including the required ones it still misses', () => {
      // Only Year is answered; Claim and Metric are still required and empty.
      // That is exactly the case that must NOT be skipped: this paper is
      // genuinely in progress, and the whole point is to still catch what is
      // left to do on it.
      const started = scaffold()
      started.Year = [{ value: 2021 }]

      const { issues, unannotated } = validateProject(
        project([paper(started, { id: 'started', title: 'Started Paper' })]),
      )
      expect(unannotated).toEqual([])
      expect(kinds(issues)).toEqual(['required', 'required'])
      expect(issues.map((i) => i.path)).toEqual(['Findings › Claim', 'Findings › Evidence › Metric'])
    })

    it('splits a mixed project into the right issues and the right skip list', () => {
      const started = scaffold()
      started.Year = [{ value: 2021 }]

      const { issues, unannotated } = validateProject(
        project([
          paper(validSample(), { id: 'valid', title: 'Valid Paper' }),
          paper({}, { id: 'empty1', title: 'Empty One' }),
          paper(started, { id: 'started', title: 'Started Paper' }),
          paper({}, { id: 'empty2', title: 'Empty Two' }),
        ]),
      )
      // Only the in-progress paper produces issues; the fully valid one does not,
      // and neither empty paper is validated at all.
      expect(issues.every((i) => i.paperId === 'started')).toBe(true)
      expect(issues.length).toBeGreaterThan(0)
      expect(unannotatedIds(unannotated)).toEqual(['empty1', 'empty2'])
    })

    it('does NOT count a boolean left at its untouched false as an annotation', () => {
      const { unannotated } = validateProject(
        project([paper({ Relevant: [{ value: false }] }, { id: 'p1' })]),
      )
      expect(unannotated).toEqual([{ paperId: 'p1', paperTitle: 'Paper One' }])
    })

    it('counts a boolean explicitly ticked true as an annotation', () => {
      const { unannotated } = validateProject(
        project([paper({ Relevant: [{ value: true }] }, { id: 'p1' })]),
      )
      expect(unannotated).toEqual([])
    })

    it('does not crash and treats malformed annotations as unannotated', () => {
      expect(() =>
        validateProject(project([paper(null as never, { id: 'p1', title: 'Broken' })])),
      ).not.toThrow()
      const { issues, unannotated } = validateProject(
        project([paper(null as never, { id: 'p1', title: 'Broken' })]),
      )
      expect(issues).toEqual([])
      expect(unannotated).toEqual([{ paperId: 'p1', paperTitle: 'Broken' }])
    })
  })
})

import { describe, it, expect } from 'vitest'
import { gateOn, type ResolvedDef } from './schema'
import type { AnnotationValueTree } from './annotations'
import { loadProject, type Paper, type Project } from './project'
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
    alignment: {},
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
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
  // [utest->req~dat-190~1]
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

  // [utest->req~dat-200~1]
  it('skips a required field hidden by an unanswered visibleIf gate', () => {
    const schema = [
      def({ name: 'Relevant', type: 'boolean' }),
      def({ name: 'Claim', type: 'string', required: true, visibleIf: gateOn('Relevant') }),
    ]
    const issues = validatePaper(
      schema,
      paper({ Relevant: [{ value: false }], Claim: [{ value: null }] }),
    )
    expect(issues).toEqual([])
  })

  it('flags the same required field once its visibleIf gate is answered', () => {
    const schema = [
      def({ name: 'Relevant', type: 'boolean' }),
      def({ name: 'Claim', type: 'string', required: true, visibleIf: gateOn('Relevant') }),
    ]
    const issues = validatePaper(
      schema,
      paper({ Relevant: [{ value: true }], Claim: [{ value: null }] }),
    )
    expect(kinds(issues)).toEqual(['required'])
  })

  it('skips a required field hidden by an unsatisfied value condition', () => {
    const schema = [
      def({ name: 'Kind', type: 'string', options: ['RCT', 'survey'] }),
      def({
        name: 'Claim',
        type: 'string',
        required: true,
        visibleIf: { mode: 'all', conditions: [{ field: 'Kind', equals: ['RCT'] }] },
      }),
    ]
    // Answered, but not with the value the gate asks for.
    expect(
      validatePaper(schema, paper({ Kind: [{ value: 'survey' }], Claim: [{ value: null }] })),
    ).toEqual([])
    expect(
      kinds(validatePaper(schema, paper({ Kind: [{ value: 'RCT' }], Claim: [{ value: null }] }))),
    ).toEqual(['required'])
  })

  it('skips a required field behind an unsatisfied nested group, and flags it once satisfied', () => {
    const schema = [
      def({ name: 'Relevant', type: 'boolean' }),
      def({ name: 'Kind', type: 'string', options: ['RCT', 'survey'] }),
      def({
        name: 'Claim',
        type: 'string',
        required: true,
        // "Relevant is Yes AND (Kind is RCT OR ...)"
        visibleIf: {
          mode: 'all',
          conditions: [
            { field: 'Relevant', equals: [true] },
            { mode: 'any', conditions: [{ field: 'Kind', equals: ['RCT'] }] },
          ],
        },
      }),
    ]
    const answers = (kind: string) =>
      paper({ Relevant: [{ value: true }], Kind: [{ value: kind }], Claim: [{ value: null }] })
    expect(validatePaper(schema, answers('survey'))).toEqual([])
    expect(kinds(validatePaper(schema, answers('RCT')))).toEqual(['required'])
  })

  it('skips a required grandchild field gated on a grandparent (an ancestor, not a sibling)', () => {
    const schema = [
      def({
        name: 'Field A',
        type: 'boolean',
        children: [
          def({
            name: 'Field B',
            type: 'string',
            children: [def({ name: 'Field C', type: 'string', required: true, visibleIf: gateOn('Field A') })],
          }),
        ],
      }),
    ]
    const hidden = validatePaper(
      schema,
      paper({
        'Field A': [{ value: false, children: { 'Field B': [{ value: 'x', children: { 'Field C': [{ value: null }] } }] } }],
      }),
    )
    expect(hidden).toEqual([])

    const shown = validatePaper(
      schema,
      paper({
        'Field A': [{ value: true, children: { 'Field B': [{ value: 'x', children: { 'Field C': [{ value: null }] } }] } }],
      }),
    )
    expect(kinds(shown)).toEqual(['required'])
  })

  it('flags a required grandchild gated on a grandparent inside a group, per grandparent entry', () => {
    const schema = [
      def({
        name: 'G',
        children: [
          def({
            name: 'Field A',
            type: 'boolean',
            max: null,
            children: [
              def({
                name: 'Field B',
                type: 'string',
                children: [def({ name: 'Field C', type: 'string', required: true, visibleIf: gateOn('Field A') })],
              }),
            ],
          }),
        ],
      }),
    ]
    const entry = (value: boolean) => ({ value, children: { 'Field B': [{ value: 'x', children: { 'Field C': [{ value: null }] } }] } })
    const issues = validatePaper(schema, paper({ G: [{ children: { 'Field A': [entry(false), entry(true)] } }] }))
    expect(issues.map((i) => [i.kind, i.canonicalPath])).toEqual([['required', 'G/Field A[1]/Field B/Field C']])
  })

  it('skips a required field hidden by a gate on another branch (an absolute path)', () => {
    const schema = [
      def({ name: 'Findings', children: [def({ name: 'Relevant', type: 'boolean' })] }),
      def({
        name: 'Study Type',
        type: 'string',
        required: true,
        visibleIf: gateOn('Findings/Relevant'),
      }),
    ]
    const answers = (relevant: boolean) =>
      paper({
        Findings: [{ children: { Relevant: [{ value: relevant }] } }],
        'Study Type': [{ value: null }],
      })
    // Resolved against the paper's whole tree, which `validatePaper` threads
    // in — so the dialog hides exactly what the form hides.
    expect(validatePaper(schema, answers(false))).toEqual([])
    expect(kinds(validatePaper(schema, answers(true)))).toEqual(['required'])
  })

  it('skips a whole group (and its required children) hidden by visibleIf', () => {
    const schema = [
      def({ name: 'Relevant', type: 'boolean' }),
      def({
        name: 'Findings',
        visibleIf: gateOn('Relevant'),
        children: [def({ name: 'Claim', type: 'string', required: true })],
      }),
    ]
    const hidden = validatePaper(
      schema,
      paper({
        Relevant: [{ value: false }],
        Findings: [{ children: { Claim: [{ value: null }] } }],
      }),
    )
    expect(hidden).toEqual([])

    const shown = validatePaper(
      schema,
      paper({
        Relevant: [{ value: true }],
        Findings: [{ children: { Claim: [{ value: null }] } }],
      }),
    )
    expect(kinds(shown)).toEqual(['required'])
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

  it('reads an entry without a value as unanswered, not as mistyped', () => {
    const schema = [def({ name: 'Claim', type: 'string', required: true })]
    expect(kinds(validatePaper(schema, paper({ Claim: [{}] })))).toEqual(['required'])
  })

  it('places a node-level issue under its parent entry', () => {
    const schema = [def({ name: 'G', children: [def({ name: 'T', type: 'string', min: 1 }), def({ name: 'L', type: 'string' })] })]
    const issues = validatePaper(schema, paper({ G: [{ children: { L: 'x' as never } }] }))
    expect(issues.map((i) => [i.kind, i.path, i.canonicalPath])).toEqual([
      ['cardinality', 'G › T', 'G/T'],
      ['type', 'G › L', 'G/L'],
    ])
  })
})

// [utest->req~dat-190~1]
describe('type — messages name what is stored', () => {
  const one = (d: ResolvedDef, tree: Record<string, unknown>) =>
    validatePaper([d], paper(tree as AnnotationValueTree)).map((i) => i.message)

  it('spells out the year bounds and accepts both ends', () => {
    const y = def({ name: 'Y', type: 'year' })
    expect(one(y, { Y: [{ value: 999 }] })).toEqual(['"Y" should be a year between 1000 and 2100 but holds a number (999).'])
    expect(one(y, { Y: [{ value: 1000 }] })).toEqual([])
    expect(one(y, { Y: [{ value: 2100 }] })).toEqual([])
  })

  it('describes booleans, lists, objects and unusual types', () => {
    const s = def({ name: 'S', type: 'string' })
    expect(one(s, { S: [{ value: true }] })).toEqual(['"S" should be a string but holds a boolean (true).'])
    expect(one(s, { S: [{ value: [1] }] })).toEqual(['"S" should be a string but holds a list.'])
    expect(one(s, { S: [{ value: { a: 1 } }] })).toEqual(['"S" should be a string but holds an object.'])
    expect(one(s, { S: [{ value: 1n }] })).toEqual(['"S" should be a string but holds a bigint (1).'])
    expect(one(def({ name: 'N', type: 'number' }), { N: [{ value: NaN }] })).toEqual([
      '"N" should be a number but holds NaN.',
    ])
  })

  it('cuts a long value preview after 40 characters', () => {
    const n = def({ name: 'N', type: 'number' })
    expect(one(n, { N: [{ value: 'a'.repeat(38) }] })).toEqual([`"N" should be a number but holds a string ("${'a'.repeat(38)}").`])
    expect(one(n, { N: [{ value: 'a'.repeat(39) }] })).toEqual([`"N" should be a number but holds a string ("${'a'.repeat(39)}…).`])
  })

  it('names what a node holds instead of a list, and what an entry is instead of an object', () => {
    const t = def({ name: 'T', type: 'string', min: 0, max: null })
    expect(one(t, { T: null })).toEqual(['"T" should hold a list of entries but holds null.'])
    expect(one(t, { T: NaN })).toEqual(['"T" should hold a list of entries but holds NaN.'])
    expect(one(t, { T: 'x' })).toEqual(['"T" should hold a list of entries but holds a string ("x").'])
    expect(one(t, { T: [undefined, [], 5] })).toEqual([
      '"T" entry should be an object but is nothing.',
      '"T" entry should be an object but is a list.',
      '"T" entry should be an object but is a number (5).',
    ])
  })

  it('treats a whitespace-only string as empty for required and enum checks', () => {
    const e = def({ name: 'E', type: 'string', required: true, options: ['A'] })
    expect(one(e, { E: [{ value: '  ' }] })).toEqual(['"E" is required but empty.'])
  })

  it('checks options only on string values', () => {
    expect(one(def({ name: 'N', type: 'number', options: ['1'] }), { N: [{ value: 2 }] })).toEqual([])
    expect(one(def({ name: 'E', type: 'string', options: [] }), { E: [{ value: 'any' }] })).toEqual([])
  })

  it('lists exactly eight options without a remainder, and counts the ninth', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => `o${i + 1}`)
    expect(one(def({ name: 'E', type: 'string', options: opts(8) }), { E: [{ value: 'x' }] })).toEqual([
      '"E" holds "x", which is not one of: o1, o2, o3, o4, o5, o6, o7, o8.',
    ])
    expect(one(def({ name: 'E', type: 'string', options: opts(9) }), { E: [{ value: 'x' }] })).toEqual([
      '"E" holds "x", which is not one of: o1, o2, o3, o4, o5, o6, o7, o8, … (+1 more).',
    ])
  })

  it('accepts counts exactly at min and max, and words plural bounds', () => {
    const t = def({ name: 'T', type: 'string', min: 2, max: 2 })
    expect(one(t, { T: [{ value: 'a' }, { value: 'b' }] })).toEqual([])
    expect(one(t, { T: [{ value: 'a' }] })).toEqual(['"T" needs at least 2 entries but has 1.'])
    expect(one(def({ name: 'T', type: 'string', min: 0, max: 1 }), { T: [{ value: 'a' }, { value: 'b' }] })).toEqual([
      '"T" allows at most 1 entry but has 2.',
    ])
  })
})

describe('duplicate entries', () => {
  it('flags a repeated entry of a unique field at its own path, tolerating malformed entries', () => {
    const d = def({ name: 'Tag', type: 'string', min: 0, max: null, unique: true })
    const issues = validatePaper([d], paper({ Tag: [{ value: 'a' }, 'bad' as never, { value: 'b' }, { value: 'a' }] }))
    expect(issues.map((i) => [i.kind, i.path, i.canonicalPath, i.message])).toEqual([
      ['type', 'Tag #2', 'Tag[1]', '"Tag" entry should be an object but is a string ("bad").'],
      ['duplicate', 'Tag #4', 'Tag[3]', '"Tag" #4 repeats #1. Each entry is allowed once.'],
    ])
  })

  it('ignores repeats when the field is not unique', () => {
    const d = def({ name: 'Tag', type: 'string', min: 0, max: null })
    expect(validatePaper([d], paper({ Tag: [{ value: 'a' }, { value: 'a' }] }))).toEqual([])
  })
})

describe('validatePaper — defensive inputs', () => {
  it('tolerates a missing paper and a non-array schema', () => {
    const issues = validatePaper([def({ name: 'T', type: 'string' })], null as never)
    expect(issues.map((i) => [i.paperId, i.paperTitle, i.kind])).toEqual([['', '', 'cardinality']])
    expect(validatePaper(null as never, paper({}))).toEqual([])
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
    const issues = validatePaper(sampleSchema, paper(tree))
    expect(issues.map((i) => i.path)).toEqual([
      'Findings #1 › Evidence › Metric',
      'Findings #2 › Claim',
      'Findings #2 › Evidence #2 › Metric',
    ])
    // The canonical path always carries the real 0-based index, regardless
    // of whether the display path bothered to number it — "Findings #1"
    // above is canonically index 0, left implicit, same as `formatPath`
    // treats every other node's first instance.
    expect(issues.map((i) => i.canonicalPath)).toEqual([
      'Findings/Evidence/Metric',
      'Findings[1]/Claim',
      'Findings[1]/Evidence[1]/Metric',
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
      provenance: null,
      protocol: null,
      schemaInfo: null,
      schemaVersion: null,
      schemaHistory: [],
      annotationsDir: null,
      schema: sampleSchema,
      aiEnabled: true,
      aiSeat: false,
      finishCheckbox: true,
      reviewers: 1,
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

// [utest->req~dat-215~1]
describe('answers hidden by a schema change are reported', () => {
  const schema = [{ name: 'Study Type', type: 'string' as const }]

  const projectWith = (annotations: Record<string, unknown>) =>
    loadProject(
      JSON.stringify({
        version: 1,
        config: { schema },
        papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: 'a.pdf', annotations }],
      }),
    )

  it('names the node, so the only trace of the data is not invisible', () => {
    const result = validateProject(projectWith({ 'Study Type': [{ value: 'RCT' }], Notes: [{ value: 'kept' }] }))
    const issue = result.issues.find((i) => i.kind === 'orphaned')
    expect(issue?.message).toContain('"Notes"')
    expect(issue?.paperId).toBe('p1')
  })

  it('does not file an orphan-only paper as "not started"', () => {
    // Nothing the current schema can see, so `hasAnnotations` says no — and
    // telling somebody their colleague has not started, while the work sits
    // right there in the file, is the worst available answer.
    const result = validateProject(projectWith({ Notes: [{ value: 'kept' }] }))
    expect(result.issues.some((i) => i.kind === 'orphaned')).toBe(true)
    expect(result.unannotated.map((u) => u.paperId)).toEqual(['p1'])
  })

  it('stays quiet for a project whose schema describes everything', () => {
    const result = validateProject(projectWith({ 'Study Type': [{ value: 'RCT' }] }))
    expect(result.issues.some((i) => i.kind === 'orphaned')).toBe(false)
  })

  it('lists five orphans and counts the rest, as a paper-level issue', () => {
    const five = { A: [{ value: 1 }], B: [{ value: 1 }], C: [{ value: 1 }], D: [{ value: 1 }], E: [{ value: 1 }] }
    const at = (extra: Record<string, unknown>) =>
      validateProject(projectWith({ ...five, ...extra })).issues.find((i) => i.kind === 'orphaned')
    expect(at({})).toMatchObject({
      path: '',
      canonicalPath: '',
      paperTitle: 'Paper One',
      message: expect.stringMatching(/^Holds answers under "A", "B", "C", "D", "E", which/),
    })
    expect(at({ F: [{ value: 1 }] })?.message).toMatch(/^Holds answers under "A", "B", "C", "D", "E", and 1 more, which/)
  })
})

// [utest->req~dat-168~1]
describe('files under an unknown schema version are reported', () => {
  const base = (over: Partial<Paper>): Project => ({
    version: 1,
    provenance: null,
    protocol: null,
    schemaInfo: null,
    schemaVersion: null,
    schemaHistory: [],
    annotationsDir: null,
    schema: sampleSchema,
    aiEnabled: false,
    aiSeat: false,
    finishCheckbox: true,
    reviewers: 2,
    papers: [paper(validSample(), over)],
    screening: null,
    extra: {},
  })

  it('names every file in words, before the paper\'s own issues', () => {
    const tree = validSample()
    tree.Year = [{ value: null }]
    const { issues } = validateProject({
      ...base({}),
      papers: [paper(tree, { unknownSchemaFiles: ['review-2', 'marks-1', 'marks-consolidated', 'consolidated'] })],
    })
    expect(issues.map((i) => [i.kind, i.path, i.canonicalPath])).toEqual([
      ['schema-version', '', ''],
      ['required', 'Year', 'Year'],
    ])
    expect(issues[0].message).toMatch(
      /^Reviewer 2's answers, Reviewer 1's PDF highlights, The PDF highlights, The consolidated answers were written under/,
    )
  })

  it('uses the singular for one file and stays quiet without any', () => {
    expect(validateProject(base({ unknownSchemaFiles: ['review-1'] })).issues[0].message).toMatch(
      /^Reviewer 1's answers was written under/,
    )
    expect(validateProject(base({ unknownSchemaFiles: 'x' as never })).issues).toEqual([])
  })

  it('reads only a whole review-N or marks-N key as a seat file', () => {
    const keys = ['review-12', 'marks-10', 'xreview-1', 'review-1x', 'xmarks-1', 'marks-1x']
    expect(validateProject(base({ unknownSchemaFiles: keys })).issues[0].message).toMatchInlineSnapshot(`"Reviewer 12's answers, Reviewer 10's PDF highlights, The consolidated answers, The consolidated answers, The consolidated answers, The consolidated answers were written under a schema version this project doesn't know — from another branch, or edited by hand — so fields renamed or moved since could not be carried over. Answers under old names are hidden."`)
  })
})

describe('validateProject — a paper that cannot be read', () => {
  it('reports an internal error instead of throwing, and keeps going', () => {
    const broken = paper({}, { id: 'bad', title: 'Bad' })
    Object.defineProperty(broken, 'annotations', {
      get() {
        throw new Error('boom')
      },
    })
    const result = validateProject({ schema: sampleSchema, papers: [broken, null] } as never)
    expect(result.issues).toEqual([
      {
        paperId: 'bad',
        paperTitle: 'Bad',
        path: '',
        canonicalPath: '',
        kind: 'type',
        message: "Could not validate this paper's annotations: Error: boom",
      },
    ])
    expect(result.unannotated).toEqual([{ paperId: '', paperTitle: '' }])
  })
})

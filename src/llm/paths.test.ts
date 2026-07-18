import { describe, it, expect } from 'vitest'
import { resolveSchema, type ResolvedDef } from '../model/schema'
import { parsePath, formatPath, displayPath, resolvePath, MAX_UNBOUNDED_INDEX } from './paths'

// ---------------------------------------------------------------------------
// The schema is built through resolveSchema, so these tests run against exactly
// the ResolvedDef shape the app produces (defaults applied, ids assigned) rather
// than a hand-rolled stand-in that could drift from it.
//
// It deliberately contains one of everything resolvePath has to reason about:
// a plain field, an enum field, an unbounded repeatable group, a nested group
// inside it, and a *bounded* repeatable group (max: 3).
// ---------------------------------------------------------------------------

const schema: ResolvedDef[] = resolveSchema([
  { name: 'Relevant', type: 'boolean' },
  { name: 'Study Type', type: 'string', options: ['RCT', 'Survey', 'Case Study'] },
  {
    name: 'Findings',
    min: 1,
    max: null, // unbounded: the model may name any index
    children: [
      { name: 'Claim', type: 'string', required: true },
      {
        name: 'Evidence',
        min: 1,
        max: 2,
        children: [{ name: 'Metric', type: 'string' }],
      },
    ],
  },
  {
    name: 'Threats to Validity',
    min: 1,
    max: 3, // bounded: index 3 and beyond must be rejected
    children: [{ name: 'Kind', type: 'string' }],
  },
])

describe('parsePath', () => {
  it('reads a bare name as index 0', () => {
    expect(parsePath('Claim')).toEqual([{ name: 'Claim', index: 0 }])
  })

  it('reads an explicit index', () => {
    expect(parsePath('Findings[2]')).toEqual([{ name: 'Findings', index: 2 }])
    // An explicit [0] is allowed on input; formatPath drops it again.
    expect(parsePath('Findings[0]')).toEqual([{ name: 'Findings', index: 0 }])
  })

  it('reads multi-segment paths, mixing indexed and bare segments', () => {
    expect(parsePath('Findings[1]/Evidence[0]/Metric')).toEqual([
      { name: 'Findings', index: 1 },
      { name: 'Evidence', index: 0 },
      { name: 'Metric', index: 0 },
    ])
  })

  // Schema node names are human-written display names, so spaces are normal.
  it('keeps spaces inside names', () => {
    expect(parsePath('Study Type')).toEqual([{ name: 'Study Type', index: 0 }])
    expect(parsePath('Threats to Validity[2]/Kind')).toEqual([
      { name: 'Threats to Validity', index: 2 },
      { name: 'Kind', index: 0 },
    ])
  })

  // Models like to pretty-print; padding around a segment must not change it.
  it('trims padding around segments', () => {
    expect(parsePath(' Findings[1] / Claim ')).toEqual([
      { name: 'Findings', index: 1 },
      { name: 'Claim', index: 0 },
    ])
  })

  it.each([
    ['', 'empty string'],
    ['A[', 'unclosed bracket'],
    ['A[x]', 'non-numeric index'],
    ['A[-1]', 'negative index'],
    ['A[]', 'empty index'],
    ['/', 'separator only'],
    ['A//B', 'empty middle segment'],
    ['A/', 'empty trailing segment'],
    ['A[1][2]', 'double index'],
    ['   ', 'whitespace only'],
  ])('returns null for malformed input %j (%s)', (raw) => {
    expect(parsePath(raw)).toBeNull()
  })
})

describe('formatPath', () => {
  it('omits index 0 so paths compare stably', () => {
    expect(formatPath([{ name: 'Claim', index: 0 }])).toBe('Claim')
    expect(
      formatPath([
        { name: 'Findings', index: 0 },
        { name: 'Evidence', index: 0 },
        { name: 'Metric', index: 0 },
      ]),
    ).toBe('Findings/Evidence/Metric')
  })

  it('renders a non-zero index as Name[i]', () => {
    expect(
      formatPath([
        { name: 'Findings', index: 1 },
        { name: 'Evidence', index: 2 },
        { name: 'Metric', index: 0 },
      ]),
    ).toBe('Findings[1]/Evidence[2]/Metric')
  })

  it('round-trips with parsePath', () => {
    const canonical = 'Findings[1]/Evidence[2]/Metric'
    expect(formatPath(parsePath(canonical)!)).toBe(canonical)

    // A non-canonical input normalises to the canonical form, and stays there.
    const normalized = formatPath(parsePath('Findings[0]/Claim')!)
    expect(normalized).toBe('Findings/Claim')
    expect(formatPath(parsePath(normalized)!)).toBe(normalized)
  })
})

describe('displayPath', () => {
  // 1-based numbering and ' › ' both mirror validate.ts, so an issue reported by
  // the validator and a field named by the AI read identically in the UI.
  it('renders 1-based numbers with the validator separator', () => {
    expect(
      displayPath([
        { name: 'Findings', index: 1 },
        { name: 'Claim', index: 0 },
      ]),
    ).toBe('Findings #2 › Claim')
  })

  it('leaves an unrepeated segment unnumbered', () => {
    expect(displayPath([{ name: 'Study Type', index: 0 }])).toBe('Study Type')
    expect(
      displayPath([
        { name: 'Findings', index: 0 },
        { name: 'Evidence', index: 1 },
        { name: 'Metric', index: 0 },
      ]),
    ).toBe('Findings › Evidence #2 › Metric')
  })
})

describe('resolvePath: accepts', () => {
  it('resolves a top-level field with an empty container path', () => {
    const r = resolvePath(schema, 'Relevant')!
    expect(r).not.toBeNull()
    expect(r.path).toEqual([])
    expect(r.name).toBe('Relevant')
    expect(r.index).toBe(0)
    expect(r.def.type).toBe('boolean')
    expect(r.canonical).toBe('Relevant')
  })

  it('resolves an enum field and hands back its options', () => {
    const r = resolvePath(schema, 'Study Type')!
    expect(r.def.options).toEqual(['RCT', 'Survey', 'Case Study'])
    expect(r.def.id).toBe('Study Type')
  })

  it('resolves a nested field and reports the container it lives in', () => {
    const r = resolvePath(schema, 'Findings[1]/Evidence[0]/Metric')!
    // The container is every segment *above* the field: exactly what the store's
    // setFieldValue needs to walk down to the right instance.
    expect(r.path).toEqual([
      { name: 'Findings', index: 1 },
      { name: 'Evidence', index: 0 },
    ])
    expect(r.name).toBe('Metric')
    expect(r.index).toBe(0)
    expect(r.def.id).toBe('Findings/Evidence/Metric')
    expect(r.def.type).toBe('string')
    expect(r.canonical).toBe('Findings[1]/Evidence/Metric')
  })

  it('resolves a field one level down', () => {
    const r = resolvePath(schema, 'Findings/Claim')!
    expect(r.path).toEqual([{ name: 'Findings', index: 0 }])
    expect(r.def.required).toBe(true)
    expect(r.canonical).toBe('Findings/Claim')
  })

  // Resolution is checked against the schema, not the data: naming a not-yet-
  // existing index is how the model records a *further* entry of a repeatable
  // node. The caller creates the missing instances when applying.
  it('allows an index that does not exist in the data yet, on an unbounded node', () => {
    const r = resolvePath(schema, 'Findings[7]/Claim')!
    expect(r).not.toBeNull()
    expect(r.path).toEqual([{ name: 'Findings', index: 7 }])
    expect(r.canonical).toBe('Findings[7]/Claim')
  })

  it('allows the last index inside a bounded node', () => {
    const r = resolvePath(schema, 'Threats to Validity[2]/Kind')!
    expect(r.path).toEqual([{ name: 'Threats to Validity', index: 2 }])
    expect(r.canonical).toBe('Threats to Validity[2]/Kind')
  })
})

describe('resolvePath: rejects', () => {
  // Everything the model sends comes through resolvePath, so each rejection here
  // is a door the model cannot open onto the project data.
  it('rejects an index at or beyond a bounded max', () => {
    expect(resolvePath(schema, 'Threats to Validity[3]/Kind')).toBeNull()
    expect(resolvePath(schema, 'Threats to Validity[99]/Kind')).toBeNull()
    // max 2 on Evidence: index 2 is one past the end.
    expect(resolvePath(schema, 'Findings/Evidence[2]/Metric')).toBeNull()
  })

  it('rejects an index on a non-repeating node (max defaults to 1)', () => {
    expect(resolvePath(schema, 'Study Type[1]')).toBeNull()
  })

  it('rejects an unknown name at any level', () => {
    expect(resolvePath(schema, 'Nope')).toBeNull()
    expect(resolvePath(schema, 'Findings/Nope')).toBeNull()
    expect(resolvePath(schema, 'Findings/Evidence/Nope')).toBeNull()
  })

  it('rejects a path that ends on a group (a group holds no value)', () => {
    expect(resolvePath(schema, 'Findings')).toBeNull()
    expect(resolvePath(schema, 'Findings[1]/Evidence')).toBeNull()
    expect(resolvePath(schema, 'Threats to Validity')).toBeNull()
  })

  it('rejects descending into a leaf field', () => {
    expect(resolvePath(schema, 'Study Type/Nope')).toBeNull()
    expect(resolvePath(schema, 'Findings/Claim/Nope')).toBeNull()
  })

  it('rejects malformed syntax', () => {
    expect(resolvePath(schema, '')).toBeNull()
    expect(resolvePath(schema, '/')).toBeNull()
    expect(resolvePath(schema, 'Findings//Claim')).toBeNull()
    expect(resolvePath(schema, 'Findings[x]/Claim')).toBeNull()
    expect(resolvePath(schema, 'Findings[-1]/Claim')).toBeNull()
  })

  it('rejects a name that only differs in case or spacing', () => {
    expect(resolvePath(schema, 'findings/Claim')).toBeNull()
    expect(resolvePath(schema, 'StudyType')).toBeNull()
  })

  it('rejects anything against an empty schema', () => {
    expect(resolvePath([], 'Relevant')).toBeNull()
  })
})

describe('resolvePath: a node with both a value and children', () => {
  // The schema allows a field to also own a sub-tree; both the node itself and
  // its children must be reachable.
  const both = resolveSchema([
    {
      name: 'Outcome',
      type: 'string',
      min: 1,
      max: null,
      children: [{ name: 'Metric', type: 'number' }],
    },
  ])

  it('resolves the node itself, because it is a field', () => {
    const r = resolvePath(both, 'Outcome[1]')!
    expect(r.path).toEqual([])
    expect(r.name).toBe('Outcome')
    expect(r.index).toBe(1)
    expect(r.def.type).toBe('string')
  })

  it('resolves through it into its children', () => {
    const r = resolvePath(both, 'Outcome[1]/Metric')!
    expect(r.path).toEqual([{ name: 'Outcome', index: 1 }])
    expect(r.def.type).toBe('number')
  })
})

describe('names containing the format\'s own punctuation round-trip', () => {
  // Regression: "/" "[" "]" are the path format's punctuation, but nothing
  // restricts a schema author from using them in a field name — and these are
  // ordinary SLR codebook names. Unescaped, "Population / Setting" split into
  // two segments and resolved to a *different* field, so a git commit wrote the
  // answer into the wrong place; "Sub-questions / RQs" resolved to nothing at
  // all, making the field permanently uncommittable.
  const names = [
    'Population / Setting',
    'Cost/Benefit',
    'Findings[1]',
    'Ref [see note]',
    'A]B',
    'Back\\slash',
    'Normal Name',
  ]

  it.each(names)('round-trips %j through formatPath/parsePath', (name) => {
    const segs = [{ name, index: 0 }]
    expect(parsePath(formatPath(segs))).toEqual(segs)
  })

  it.each(names)('round-trips %j at a non-zero index', (name) => {
    const segs = [{ name, index: 2 }]
    expect(parsePath(formatPath(segs))).toEqual(segs)
  })

  it('round-trips a nested path whose every segment needs escaping', () => {
    const segs = [
      { name: 'Population / Setting', index: 1 },
      { name: 'Ref [see note]', index: 0 },
    ]
    expect(parsePath(formatPath(segs))).toEqual(segs)
  })

  it('leaves ordinary names byte-identical, so persisted paper.equal keys still match', () => {
    // The whole reason escaping is opt-in per character: these strings are
    // stored in project files.
    expect(formatPath([{ name: 'Study Type', index: 0 }])).toBe('Study Type')
    expect(formatPath([{ name: 'Findings', index: 1 }, { name: 'Claim', index: 0 }])).toBe(
      'Findings[1]/Claim',
    )
  })

  it('a slash-named field no longer resolves to a different field', () => {
    const schema = resolveSchema([
      { name: 'Population', children: [{ name: 'Setting', type: 'string' }] },
      { name: 'Population / Setting', type: 'string' },
    ])
    const canonical = formatPath([{ name: 'Population / Setting', index: 0 }])
    const r = resolvePath(schema, canonical)
    expect(r?.name).toBe('Population / Setting')
    expect(r?.path).toEqual([]) // top level, NOT inside the Population group
  })

  it('a slash-named field is resolvable at all (was permanently uncommittable)', () => {
    const schema = resolveSchema([{ name: 'Sub-questions / RQs', type: 'string' }])
    const canonical = formatPath([{ name: 'Sub-questions / RQs', index: 0 }])
    expect(resolvePath(schema, canonical)?.name).toBe('Sub-questions / RQs')
  })
})

describe('unbounded-index ceiling', () => {
  const schema = resolveSchema([
    { name: 'Findings', min: 0, max: null, children: [{ name: 'Claim', type: 'string' }] },
  ])

  it('has no ceiling unless the caller asks for one', () => {
    // git/merge.ts's applyOne and git/changes.ts resolve paths that already
    // exist in the project. A ceiling there silently dropped a conflict the
    // reviewer had explicitly resolved by hand — the merge kept "ours" with no
    // error. Only the LLM entry points, which materialize every instance up to
    // the index, opt in.
    expect(resolvePath(schema, 'Findings[10000]/Claim')).not.toBeNull()
    expect(resolvePath(schema, 'Findings[99999]/Claim')).not.toBeNull()
  })

  it('applies the ceiling when asked', () => {
    const opts = { maxUnboundedIndex: MAX_UNBOUNDED_INDEX }
    expect(resolvePath(schema, 'Findings[9999]/Claim', opts)).not.toBeNull()
    expect(resolvePath(schema, 'Findings[10000]/Claim', opts)).toBeNull()
    expect(resolvePath(schema, 'Findings[9007199254740990]/Claim', opts)).toBeNull()
  })
})

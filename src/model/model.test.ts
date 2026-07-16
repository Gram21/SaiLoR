import { describe, it, expect } from 'vitest'
import { resolveSchema, isRepeatable, type AnnotationDef } from './schema'
import {
  initTree,
  normalizeTree,
  pruneTree,
  canAdd,
  canRemove,
  makeInstance,
  annotationText,
  type AnnotationValueTree,
} from './annotations'
import { loadProject, serializeProject, ProjectLoadError } from './project'

const sampleSchema: AnnotationDef[] = [
  { name: 'Relevant', type: 'boolean' },
  { name: 'Study Type', type: 'string', min: 1, max: 1 },
  { name: 'Year', type: 'number' },
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [
      { name: 'Claim', type: 'string' },
      { name: 'Evidence', type: 'string' },
      { name: 'Confidence', type: 'number' },
    ],
  },
]

function makeProjectJson(annotations: unknown = {}) {
  return JSON.stringify({
    version: 1,
    config: { schema: sampleSchema },
    papers: [
      {
        id: 'p1',
        title: 'Some Paper',
        authors: ['A. Author'],
        doi: '10.1000/xyz',
        pdf: 'pdfs/some.pdf',
        annotations,
      },
    ],
  })
}

describe('schema resolution', () => {
  it('applies defaults and assigns path ids', () => {
    const resolved = resolveSchema(sampleSchema)
    expect(resolved[0]).toMatchObject({ id: 'Relevant', min: 1, max: 1 })
    const findings = resolved[3]
    expect(findings.max).toBeNull()
    expect(findings.children[0].id).toBe('Findings/Claim')
  })

  it('flags a node with neither type nor children', () => {
    expect(() => loadProject(
      JSON.stringify({ config: { schema: [{ name: 'Bad' }] }, papers: [] }),
    )).toThrow(ProjectLoadError)
  })

  it('rejects duplicate sibling names', () => {
    const dup: AnnotationDef[] = [
      { name: 'X', type: 'string' },
      { name: 'X', type: 'number' },
    ]
    expect(() => resolveSchema(dup)).toThrow(/Duplicate sibling/)
  })

  it('resolves and round-trips enum options', () => {
    const opts = ['A', 'B', 'C']
    const resolved = resolveSchema([{ name: 'Kind', type: 'string', options: opts }])
    expect(resolved[0].options).toEqual(opts)

    const project = loadProject(
      JSON.stringify({
        config: { schema: [{ name: 'Kind', type: 'string', options: opts }] },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
    )
    const reDumped = JSON.parse(serializeProject(project))
    expect(reDumped.config.schema[0].options).toEqual(opts)
  })

  it('rejects options on a non-string field', () => {
    expect(() =>
      loadProject(
        JSON.stringify({
          config: { schema: [{ name: 'N', type: 'number', options: ['1', '2'] }] },
          papers: [],
        }),
      ),
    ).toThrow(ProjectLoadError)
  })

  it('rejects max < min', () => {
    expect(() =>
      loadProject(
        JSON.stringify({
          config: { schema: [{ name: 'X', type: 'string', min: 3, max: 2 }] },
          papers: [],
        }),
      ),
    ).toThrow(ProjectLoadError)
  })

  it('defaults required to false and round-trips it only when set', () => {
    const project = loadProject(
      JSON.stringify({
        config: {
          schema: [
            { name: 'Relevant', type: 'boolean', required: true },
            { name: 'Notes', type: 'string' },
          ],
        },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
    )
    expect(project.schema[0].required).toBe(true)
    expect(project.schema[1].required).toBe(false)

    const reDumped = JSON.parse(serializeProject(project))
    expect(reDumped.config.schema[0].required).toBe(true)
    // false is the default, so the key stays out of the file.
    expect('required' in reDumped.config.schema[1]).toBe(false)
  })

  it('rejects required on a group (a group holds no value)', () => {
    expect(() =>
      loadProject(
        JSON.stringify({
          config: {
            schema: [
              { name: 'G', required: true, children: [{ name: 'Claim', type: 'string' }] },
            ],
          },
          papers: [],
        }),
      ),
    ).toThrow(ProjectLoadError)
  })

  it('detects repeatable nodes', () => {
    const resolved = resolveSchema(sampleSchema)
    expect(isRepeatable(resolved[3])).toBe(true)
    expect(isRepeatable(resolved[0])).toBe(false)
  })
})

describe('annotation tree init', () => {
  it('creates at least min (>=1) instances', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = initTree(resolved)
    expect(tree['Relevant']).toHaveLength(1)
    expect(tree['Findings']).toHaveLength(1)
    expect(tree['Findings'][0].children!['Claim']).toHaveLength(1)
    // boolean defaults false, others null
    expect(tree['Relevant'][0].value).toBe(false)
    expect(tree['Year'][0].value).toBeNull()
  })

  it('makeInstance builds nested structure', () => {
    const findings = resolveSchema(sampleSchema)[3]
    const inst = makeInstance(findings)
    expect(inst.children!['Confidence'][0].value).toBeNull()
    expect(inst.value).toBeUndefined() // group node has no value
  })
})

describe('add/remove guards', () => {
  it('canAdd respects max (unbounded and finite)', () => {
    const resolved = resolveSchema(sampleSchema)
    expect(canAdd(resolved[3], 5)).toBe(true) // unbounded
    expect(canAdd(resolved[1], 1)).toBe(false) // max 1
  })

  it('canRemove respects min (floor of 1)', () => {
    const resolved = resolveSchema(sampleSchema)
    expect(canRemove(resolved[3], 1)).toBe(false)
    expect(canRemove(resolved[3], 2)).toBe(true)
  })
})

describe('normalize', () => {
  it('pads missing and clamps excess instances', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = normalizeTree(resolved, {
      Findings: [
        { children: { Claim: [{ value: 'a' }], Evidence: [{ value: 'b' }], Confidence: [{ value: 1 }] } },
        { children: { Claim: [{ value: 'c' }], Evidence: [{ value: 'd' }], Confidence: [{ value: 2 }] } },
      ],
    })
    expect(tree['Findings']).toHaveLength(2)
    expect(tree['Relevant']).toHaveLength(1) // padded
    expect(tree['Relevant'][0].value).toBe(false)
  })

  it('drops keys not in the schema', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = normalizeTree(resolved, { Bogus: [{ value: 'x' }] } as never)
    expect(tree['Bogus']).toBeUndefined()
  })
})

describe('load -> edit -> serialize -> reload round-trip', () => {
  it('preserves filled annotation data', () => {
    const project = loadProject(makeProjectJson())
    const paper = project.papers[0]
    paper.annotations['Relevant'][0].value = true
    paper.annotations['Study Type'][0].value = 'RCT'
    paper.annotations['Year'][0].value = 2021
    paper.annotations['Findings'][0].children!['Claim'][0].value = 'X improves Y'
    // add a second finding
    paper.annotations['Findings'].push(
      makeInstance(project.schema[3]),
    )
    paper.annotations['Findings'][1].children!['Claim'][0].value = 'Z reduces W'

    const json = serializeProject(project)
    const reloaded = loadProject(json)
    const rp = reloaded.papers[0]
    expect(rp.annotations['Relevant'][0].value).toBe(true)
    expect(rp.annotations['Study Type'][0].value).toBe('RCT')
    expect(rp.annotations['Year'][0].value).toBe(2021)
    expect(rp.annotations['Findings']).toHaveLength(2)
    expect(rp.annotations['Findings'][1].children!['Claim'][0].value).toBe('Z reduces W')
  })

  it('preserves extra/unknown fields and config on save', () => {
    const project = loadProject(
      JSON.stringify({
        version: 2,
        note: 'keep me',
        config: { schema: sampleSchema },
        papers: [
          { id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {}, tag: 'x' },
        ],
      }),
    )
    const json = JSON.parse(serializeProject(project))
    expect(json.note).toBe('keep me')
    expect(json.papers[0].tag).toBe('x')
    expect(json.config.schema[3].name).toBe('Findings')
    expect(json.config.schema[3].max).toBeNull()
  })
})

describe('prune', () => {
  it('drops trailing empty optional instances but keeps min', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = initTree(resolved)
    // Two empty findings; min is 1 so one should remain.
    tree['Findings'].push(makeInstance(resolved[3]))
    const pruned = pruneTree(resolved, tree)
    expect(pruned['Findings']).toHaveLength(1)
  })
})

describe('annotationText (annotation-mode search haystack)', () => {
  it('collects filled string and number values, lowercased and space-joined', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = initTree(resolved)
    tree['Study Type'][0].value = 'RCT'
    tree['Year'][0].value = 2021
    tree['Findings'][0].children!['Claim'][0].value = 'X Improves Y'
    expect(annotationText(resolved, tree)).toBe('rct 2021 x improves y')
  })

  it('skips booleans — every paper has one, so it would match every search', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = initTree(resolved)
    tree['Relevant'][0].value = true
    expect(annotationText(resolved, tree)).toBe('')
  })

  it('skips empty/null values but keeps the real 0', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = initTree(resolved)
    tree['Year'][0].value = 0
    expect(annotationText(resolved, tree)).toBe('0')
  })

  it('walks nested children, not just top-level fields', () => {
    const resolved = resolveSchema(sampleSchema)
    const tree = initTree(resolved)
    tree['Findings'][0].children!['Claim'][0].value = 'Alpha'
    tree['Findings'][0].children!['Evidence'][0].value = 'Beta'
    tree['Findings'].push(makeInstance(resolved[3]))
    tree['Findings'][1].children!['Claim'][0].value = 'Gamma'
    expect(annotationText(resolved, tree)).toBe('alpha beta gamma')
  })

  it('never throws on a hand-edited tree that does not match the schema shape', () => {
    const resolved = resolveSchema(sampleSchema)
    const malformed = {
      Relevant: 'not-an-array',
      'Study Type': [null, 42, { value: 'ok' }, { children: 'nope' }],
      Findings: [{ children: { Claim: [{ value: 'nested ok' }] } }],
    } as unknown as AnnotationValueTree
    expect(() => annotationText(resolved, malformed)).not.toThrow()
    expect(annotationText(resolved, malformed)).toBe('ok nested ok')
  })

  it('returns an empty string for a paper with no annotations at all', () => {
    const resolved = resolveSchema(sampleSchema)
    expect(annotationText(resolved, {})).toBe('')
  })
})

describe('config.ai (AI-annotation opt-out)', () => {
  const withAi = (ai: unknown) =>
    JSON.stringify({
      version: 1,
      config: { schema: sampleSchema, ...(ai === undefined ? {} : { ai }) },
      papers: [],
    })

  it('defaults to enabled when config.ai is absent', () => {
    expect(loadProject(withAi(undefined)).aiEnabled).toBe(true)
  })

  it('is disabled only by an explicit false', () => {
    expect(loadProject(withAi(false)).aiEnabled).toBe(false)
    expect(loadProject(withAi(true)).aiEnabled).toBe(true)
  })

  it('writes config.ai: false only when disabled, and keeps a normal file clean', () => {
    const enabled = JSON.parse(serializeProject(loadProject(withAi(undefined))))
    expect('ai' in enabled.config).toBe(false)

    const disabled = JSON.parse(serializeProject(loadProject(withAi(false))))
    expect(disabled.config.ai).toBe(false)
  })

  it('round-trips the opt-out through load → serialize → reload', () => {
    const once = serializeProject(loadProject(withAi(false)))
    expect(loadProject(once).aiEnabled).toBe(false)
  })
})

describe('Paper.aiUsage (AI-use disclosure)', () => {
  const withUsage = (aiUsage: unknown) =>
    JSON.stringify({
      version: 1,
      config: { schema: sampleSchema },
      papers: [
        {
          id: 'p1',
          title: 'Some Paper',
          authors: [],
          pdf: 'pdfs/some.pdf',
          annotations: {},
          ...(aiUsage === undefined ? {} : { aiUsage }),
        },
      ],
    })

  it('is empty when AI was never used on the paper', () => {
    expect(loadProject(withUsage(undefined)).papers[0].aiUsage).toEqual([])
  })

  it('loads a well-formed record', () => {
    const record = { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-07-15T10:00:00.000Z' }
    expect(loadProject(withUsage([record])).papers[0].aiUsage).toEqual([record])
  })

  it('keeps array order — that order is how "which use came first" is read', () => {
    const a = { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-07-15T10:00:00.000Z' }
    const b = { provider: 'anthropic', model: 'claude-opus-4-8', appliedAt: '2026-07-15T10:05:00.000Z' }
    expect(loadProject(withUsage([a, b])).papers[0].aiUsage).toEqual([a, b])
  })

  it('drops malformed entries rather than failing the whole file to load — the JSON is hand-editable', () => {
    const good = { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-07-15T10:00:00.000Z' }
    const cases = [
      null,
      'not an object',
      42,
      {}, // missing every field
      { provider: 'openai' }, // missing model/appliedAt
      { provider: 'openai', model: 123, appliedAt: '2026-07-15T10:00:00.000Z' }, // wrong type
    ]
    for (const bad of cases) {
      expect(loadProject(withUsage([good, bad])).papers[0].aiUsage).toEqual([good])
    }
    // A paper whose key isn't even an array (hand-edited into an object, say).
    expect(loadProject(withUsage({ oops: true })).papers[0].aiUsage).toEqual([])
  })

  it('is written only when non-empty, so a paper AI never touched stays clean', () => {
    const untouched = JSON.parse(serializeProject(loadProject(withUsage(undefined))))
    expect('aiUsage' in untouched.papers[0]).toBe(false)

    const used = JSON.parse(
      serializeProject(
        loadProject(withUsage([{ provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-07-15T10:00:00.000Z' }])),
      ),
    )
    expect(used.papers[0].aiUsage).toHaveLength(1)
  })

  it('round-trips through load → serialize → reload', () => {
    const record = { provider: 'google', model: 'gemini-3.5-flash', appliedAt: '2026-07-15T10:00:00.000Z' }
    const once = serializeProject(loadProject(withUsage([record])))
    expect(loadProject(once).papers[0].aiUsage).toEqual([record])
  })
})

describe('multiple reviewers (config.reviewers, Paper.reviews)', () => {
  const withReviewers = (reviewers: unknown, paperExtra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      config: {
        schema: sampleSchema,
        ...(reviewers === undefined ? {} : { reviewers }),
      },
      papers: [
        {
          id: 'p1',
          title: 'Some Paper',
          authors: [],
          pdf: 'pdfs/some.pdf',
          annotations: {},
          ...paperExtra,
        },
      ],
    })

  it('defaults to 1 (single-reviewer) when config.reviewers is absent', () => {
    expect(loadProject(withReviewers(undefined)).reviewers).toBe(1)
  })

  it('reads a present reviewer count', () => {
    expect(loadProject(withReviewers(3)).reviewers).toBe(3)
  })

  it('rejects a reviewer count outside [1, 10] — the same bound the editor UI offers', () => {
    expect(() => loadProject(withReviewers(0))).toThrow(ProjectLoadError)
    expect(() => loadProject(withReviewers(11))).toThrow(ProjectLoadError)
  })

  it('writes config.reviewers only when it says more than the default, keeping a single-reviewer file clean', () => {
    const single = JSON.parse(serializeProject(loadProject(withReviewers(undefined))))
    expect('reviewers' in single.config).toBe(false)

    const explicit1 = JSON.parse(serializeProject(loadProject(withReviewers(1))))
    expect('reviewers' in explicit1.config).toBe(false)

    const multi = JSON.parse(serializeProject(loadProject(withReviewers(3))))
    expect(multi.config.reviewers).toBe(3)
  })

  it('a single-reviewer project round-trips byte-identical to before this feature existed', () => {
    // No `reviews` on any paper, no `config.reviewers` — nothing new in the file
    // at all for the common case, exactly like the config.ai opt-out's own test.
    const project = loadProject(withReviewers(undefined))
    const text = serializeProject(project)
    expect(text).not.toContain('"reviews"')
    expect(text).not.toContain('"reviewers"')
    // And reloading it produces the exact same text again.
    expect(serializeProject(loadProject(text))).toBe(text)
  })

  it('parses each reviewer\'s tree, normalized against the schema like annotations is', () => {
    const project = loadProject(
      withReviewers(2, {
        reviews: {
          '1': { Relevant: [{ value: true }] },
          '2': { Year: [{ value: 2021 }] },
        },
      }),
    )
    const reviews = project.papers[0].reviews
    expect(reviews['1'].Relevant[0].value).toBe(true)
    // Padded to the schema's min, same as normalizeTree does for `annotations`.
    expect(reviews['1'].Year).toHaveLength(1)
    expect(reviews['2'].Year[0].value).toBe(2021)
  })

  it('drops malformed or non-reviewer-shaped review keys rather than failing the whole file to load', () => {
    const project = loadProject(
      withReviewers(2, {
        reviews: {
          '1': { Relevant: [{ value: true }] },
          abc: { Relevant: [{ value: true }] }, // not a reviewer number
          '0': { Relevant: [{ value: true }] }, // reviewer numbers start at 1
        },
      }),
    )
    expect(Object.keys(project.papers[0].reviews)).toEqual(['1'])
  })

  it('tolerates reviews being the wrong shape entirely (hand-edited into an array, say)', () => {
    const project = loadProject(withReviewers(2, { reviews: ['not', 'an', 'object'] }))
    expect(project.papers[0].reviews).toEqual({})
  })

  it('a paper no reviewer has touched carries no reviews key, keeping the file tidy', () => {
    const untouched = JSON.parse(serializeProject(loadProject(withReviewers(2))))
    expect('reviews' in untouched.papers[0]).toBe(false)
  })

  it('writes and prunes each reviewer tree the same way annotations is pruned', () => {
    const project = loadProject(
      withReviewers(2, {
        reviews: { '1': { Relevant: [{ value: true }] } },
      }),
    )
    const out = JSON.parse(serializeProject(project))
    expect(out.papers[0].reviews['1'].Relevant).toEqual([{ value: true }])
    // A reviewer's tree the same tests never touched is absent, not `{}`.
    expect('2' in out.papers[0].reviews).toBe(false)
  })

  it('round-trips a multi-reviewer project — config.reviewers, and every reviewer tree — through load → serialize → reload', () => {
    const original = loadProject(
      withReviewers(3, {
        reviews: {
          '1': { Relevant: [{ value: true }], Year: [{ value: 2020 }] },
          '2': { Relevant: [{ value: false }] },
        },
      }),
    )
    const reloaded = loadProject(serializeProject(original))
    expect(reloaded.reviewers).toBe(3)
    expect(reloaded.papers[0].reviews['1'].Year[0].value).toBe(2020)
    expect(reloaded.papers[0].reviews['2'].Relevant[0].value).toBe(false)
    // Reviewer 3 never wrote anything — absent, not a padded empty entry.
    expect('3' in reloaded.papers[0].reviews).toBe(false)
    // `annotations` (the consolidated tree) is untouched by any of this.
    expect(reloaded.papers[0].annotations).toEqual(original.papers[0].annotations)
  })
})

describe('Paper.equal (consolidator-declared field equality)', () => {
  const withEqual = (equal: unknown) =>
    JSON.stringify({
      version: 1,
      config: { schema: sampleSchema, reviewers: 2 },
      papers: [
        {
          id: 'p1',
          title: 'Some Paper',
          authors: [],
          pdf: 'pdfs/some.pdf',
          annotations: {},
          ...(equal === undefined ? {} : { equal }),
        },
      ],
    })

  it('is empty when nothing has been marked equal', () => {
    expect(loadProject(withEqual(undefined)).papers[0].equal).toEqual([])
  })

  it('loads a well-formed list of canonical paths', () => {
    const paths = ['Study Type', 'Findings[1]/Claim']
    expect(loadProject(withEqual(paths)).papers[0].equal).toEqual(paths)
  })

  it('dedupes a hand-edited duplicate rather than let it toggle differently from a clean one', () => {
    expect(loadProject(withEqual(['Study Type', 'Study Type'])).papers[0].equal).toEqual(['Study Type'])
  })

  it('drops malformed entries rather than failing the whole file to load', () => {
    expect(loadProject(withEqual(['Study Type', 42, null, {}, ['x'], true])).papers[0].equal).toEqual([
      'Study Type',
    ])
    // The whole field being the wrong shape entirely (hand-edited into an object, say).
    expect(loadProject(withEqual({ oops: true })).papers[0].equal).toEqual([])
  })

  it('is written only when non-empty, so a paper with no marks stays clean', () => {
    const untouched = JSON.parse(serializeProject(loadProject(withEqual(undefined))))
    expect('equal' in untouched.papers[0]).toBe(false)

    const marked = JSON.parse(serializeProject(loadProject(withEqual(['Study Type']))))
    expect(marked.papers[0].equal).toEqual(['Study Type'])
  })

  it('round-trips through load → serialize → reload', () => {
    const paths = ['Study Type', 'Findings[1]/Claim']
    const once = serializeProject(loadProject(withEqual(paths)))
    expect(loadProject(once).papers[0].equal).toEqual(paths)
  })
})

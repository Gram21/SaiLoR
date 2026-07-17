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
            { name: 'Claim', type: 'string', required: true },
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

  it('drops required on a boolean field — a checkbox is never empty, so it can never fire', () => {
    // Not a load error (a file with this currently opens), just silently
    // dropped at resolve time and never re-serialized — see resolveSchema.
    const project = loadProject(
      JSON.stringify({
        config: { schema: [{ name: 'Relevant', type: 'boolean', required: true }] },
        papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
      }),
    )
    expect(project.schema[0].required).toBe(false)
    const reDumped = JSON.parse(serializeProject(project))
    expect('required' in reDumped.config.schema[0]).toBe(false)
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

  it('drops malformed or non-reviewer-shaped review keys, but still backfills every real reviewer', () => {
    const project = loadProject(
      withReviewers(2, {
        reviews: {
          '1': { Relevant: [{ value: true }] },
          abc: { Relevant: [{ value: true }] }, // not a reviewer number
          '0': { Relevant: [{ value: true }] }, // reviewer numbers start at 1
        },
      }),
    )
    // "abc" and "0" are dropped; "2" is not in the file at all but is still
    // backfilled, since `config.reviewers` says there are two reviewers.
    expect(Object.keys(project.papers[0].reviews)).toEqual(['1', '2'])
  })

  it('tolerates reviews being the wrong shape entirely (hand-edited into an array, say)', () => {
    const project = loadProject(withReviewers(2, { reviews: ['not', 'an', 'object'] }))
    // Nothing survives from the malformed value, but both reviewers still get
    // an empty skeleton — the same as if `reviews` had been absent outright.
    const resolved = resolveSchema(sampleSchema)
    const empty = normalizeTree(resolved, undefined)
    expect(project.papers[0].reviews).toEqual({ '1': empty, '2': empty })
  })

  it('a paper no reviewer has touched still gets a full reviews skeleton, one entry per reviewer', () => {
    // The point of this feature: a reviewer's first real annotation should
    // change a value on a line that was already there, not add a brand-new
    // key — that is what makes a later `git merge` of two reviewers' copies
    // tractable instead of a guaranteed conflict on the `reviews` object itself.
    const untouched = JSON.parse(serializeProject(loadProject(withReviewers(2))))
    expect(Object.keys(untouched.papers[0].reviews)).toEqual(['1', '2'])
    const resolved = resolveSchema(sampleSchema)
    const empty = pruneTree(resolved, normalizeTree(resolved, undefined))
    expect(untouched.papers[0].reviews['1']).toEqual(empty)
    expect(untouched.papers[0].reviews['2']).toEqual(empty)
  })

  it('writes and prunes each reviewer tree the same way annotations is pruned', () => {
    const project = loadProject(
      withReviewers(2, {
        reviews: { '1': { Relevant: [{ value: true }] } },
      }),
    )
    const out = JSON.parse(serializeProject(project))
    expect(out.papers[0].reviews['1'].Relevant).toEqual([{ value: true }])
    // Reviewer 2 never wrote anything, but their key is still there — an empty
    // skeleton, not a missing key — for the same git-diff reason as above.
    const resolved = resolveSchema(sampleSchema)
    expect(out.papers[0].reviews['2']).toEqual(pruneTree(resolved, normalizeTree(resolved, undefined)))
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
    // Reviewer 3 never wrote anything — still present, as an empty skeleton.
    expect('3' in reloaded.papers[0].reviews).toBe(true)
    expect(reloaded.papers[0].reviews['3']).toEqual(
      normalizeTree(resolveSchema(sampleSchema), undefined),
    )
    // `annotations` (the consolidated tree) is untouched by any of this.
    expect(reloaded.papers[0].annotations).toEqual(original.papers[0].annotations)
  })

  it('re-serializing an already-canonical multi-reviewer file is idempotent', () => {
    // The auto-migrate-on-open feature (store.ts's loadFromText) decides
    // whether a file needs fixing by comparing it to its own re-serialized
    // form — that only works, and only avoids re-writing every file on every
    // open, if a file this function already produced serializes back to
    // itself unchanged.
    const once = serializeProject(loadProject(withReviewers(3)))
    const twice = serializeProject(loadProject(once))
    expect(twice).toBe(once)
  })
})

describe('config.reviewerIdentities (seat provenance)', () => {
  const withIdentities = (reviewers: number, reviewerIdentities?: unknown) =>
    JSON.stringify({
      version: 1,
      config: {
        schema: sampleSchema,
        reviewers,
        ...(reviewerIdentities === undefined ? {} : { reviewerIdentities }),
      },
      papers: [{ id: 'p1', title: 'Some Paper', authors: [], pdf: 'pdfs/some.pdf', annotations: {} }],
    })

  it('back-compat: a file with no identities loads with an empty map', () => {
    const project = loadProject(withIdentities(2))
    expect(project.reviewerIdentities).toEqual({})
  })

  it('back-compat: a plain "reviewers: 2" file round-trips with a byte-identical config — no reviewerIdentities key appears', () => {
    const text = serializeProject(loadProject(withIdentities(2)))
    expect(text).not.toContain('reviewerIdentities')
    const config = JSON.parse(text).config
    expect(Object.keys(config).sort()).toEqual(['reviewers', 'schema'])
  })

  it('parses and round-trips identities for numbered seats and consolidation', () => {
    const project = loadProject(
      withIdentities(2, {
        '1': { email: 'alice@kit.edu', name: 'Alice' },
        '2': { email: 'bob@kit.edu' },
        consolidation: { email: 'carol@kit.edu', name: 'Carol' },
      }),
    )
    expect(project.reviewerIdentities).toEqual({
      '1': { email: 'alice@kit.edu', name: 'Alice' },
      '2': { email: 'bob@kit.edu' },
      consolidation: { email: 'carol@kit.edu', name: 'Carol' },
    })
    const reloaded = loadProject(serializeProject(project))
    expect(reloaded.reviewerIdentities).toEqual(project.reviewerIdentities)
  })

  it('drops hand-edited garbage without throwing', () => {
    expect(() => loadProject(withIdentities(2, 'nope'))).not.toThrow()
    expect(loadProject(withIdentities(2, 'nope')).reviewerIdentities).toEqual({})

    const project = loadProject(
      withIdentities(2, {
        '0': { email: 'a@kit.edu' }, // not a seat
        '1': { email: 42 }, // not a string email
        '2': { email: 'ok@kit.edu' },
      }),
    )
    expect(project.reviewerIdentities).toEqual({ '2': { email: 'ok@kit.edu' } })
  })

  it('is only written when non-empty, grouped with config.reviewers', () => {
    const withClaim = JSON.parse(
      serializeProject(loadProject(withIdentities(2, { '1': { email: 'alice@kit.edu' } }))),
    )
    expect(withClaim.config.reviewerIdentities).toEqual({ '1': { email: 'alice@kit.edu' } })

    const without = JSON.parse(serializeProject(loadProject(withIdentities(2))))
    expect('reviewerIdentities' in without.config).toBe(false)
  })

  it('serializes seats in canonical order regardless of the file\'s own key order', () => {
    const text = serializeProject(
      loadProject(
        withIdentities(3, {
          consolidation: { email: 'c@kit.edu' },
          '2': { email: 'b@kit.edu' },
          '1': { email: 'a@kit.edu' },
        }),
      ),
    )
    const keys = Object.keys(JSON.parse(text).config.reviewerIdentities)
    expect(keys).toEqual(['1', '2', 'consolidation'])
  })

  it('premise: an unrecognised config key is dropped on round-trip, which is why this had to be a typed field', () => {
    const withUnknownConfigKey = JSON.stringify({
      version: 1,
      config: { schema: sampleSchema, someUnknownKey: { a: 1 } },
      papers: [],
    })
    const text = serializeProject(loadProject(withUnknownConfigKey))
    expect(text).not.toContain('someUnknownKey')
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

describe('screening', () => {
  const screeningProject = (opts: {
    schema?: unknown
    screening?: unknown
    pdf?: string
  } = {}) =>
    JSON.stringify({
      version: 1,
      config: {
        ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
        screening: opts.screening ?? { reasons: ['Wrong topic', 'Duplicate'] },
      },
      papers: [
        {
          id: 'p1',
          title: 'Some Paper',
          authors: [],
          pdf: opts.pdf ?? '',
          annotations: {},
        },
      ],
    })

  it('round-trips config.screening', () => {
    const project = loadProject(screeningProject())
    expect(project.screening).toEqual({ reasons: ['Wrong topic', 'Duplicate'] })
  })

  it('derives config.schema and overwrites whatever the file said', () => {
    const project = loadProject(
      screeningProject({ schema: [{ name: 'Something else entirely', type: 'string' }] }),
    )
    expect(project.schema.map((d) => d.name)).toEqual(['Decision', 'Reason'])

    const reserialized = JSON.parse(serializeProject(project))
    expect(reserialized.config.schema.map((d: { name: string }) => d.name)).toEqual(['Decision', 'Reason'])
  })

  it('loads with no config.schema in the file at all', () => {
    const project = loadProject(screeningProject())
    expect(project.schema.map((d) => d.name)).toEqual(['Decision', 'Reason'])
  })

  it('a non-screening file with no/empty config.schema still fails to load', () => {
    expect(() =>
      loadProject(JSON.stringify({ config: { schema: [] }, papers: [] })),
    ).toThrow(ProjectLoadError)
    expect(() => loadProject(JSON.stringify({ config: {}, papers: [] }))).toThrow(ProjectLoadError)
  })

  it('a screening paper may have pdf: "" — a non-screening paper still may not', () => {
    expect(() => loadProject(screeningProject({ pdf: '' }))).not.toThrow()
    const nonScreening = JSON.stringify({
      version: 1,
      config: { schema: sampleSchema },
      papers: [{ id: 'p1', title: 'T', authors: [], pdf: '', annotations: {} }],
    })
    try {
      loadProject(nonScreening)
      expect.unreachable('expected loadProject to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectLoadError)
      expect((err as ProjectLoadError).details.join(' ')).toMatch(/needs a "pdf" path/i)
    }
  })

  it('trims and dedupes config.screening.reasons', () => {
    const project = loadProject(
      screeningProject({ screening: { reasons: [' Wrong topic ', 'Wrong topic', 'Duplicate', ''] } }),
    )
    expect(project.screening).toEqual({ reasons: ['Wrong topic', 'Duplicate'] })
  })

  it('an all-blank reasons list is a ProjectLoadError', () => {
    expect(() => loadProject(screeningProject({ screening: { reasons: ['  ', ''] } }))).toThrow(
      ProjectLoadError,
    )
  })

  it('paper.abstract round-trips and is omitted when empty', () => {
    const withAbstract = JSON.stringify({
      version: 1,
      config: { schema: sampleSchema },
      papers: [
        { id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', abstract: 'An abstract.', annotations: {} },
      ],
    })
    const project = loadProject(withAbstract)
    expect(project.papers[0].abstract).toBe('An abstract.')
    const reserialized = JSON.parse(serializeProject(project))
    expect(reserialized.papers[0].abstract).toBe('An abstract.')

    const withoutAbstract = makeProjectJson()
    expect(loadProject(withoutAbstract).papers[0].abstract).toBeUndefined()
    const reNoAbstract = JSON.parse(serializeProject(loadProject(withoutAbstract)))
    expect('abstract' in reNoAbstract.papers[0]).toBe(false)
  })

  it('paper.abstractFromPdf round-trips alongside a real abstract', () => {
    const withFlag = JSON.stringify({
      version: 1,
      config: { schema: sampleSchema },
      papers: [
        {
          id: 'p1',
          title: 'T',
          authors: [],
          pdf: 'a.pdf',
          abstract: 'Extracted text.',
          abstractFromPdf: true,
          annotations: {},
        },
      ],
    })
    const project = loadProject(withFlag)
    expect(project.papers[0].abstractFromPdf).toBe(true)
    const reserialized = JSON.parse(serializeProject(project))
    expect(reserialized.papers[0].abstractFromPdf).toBe(true)
  })

  it('drops abstractFromPdf as meaningless without an abstract to describe', () => {
    // A hand-edited or stale file: the abstract was deleted but the flag was
    // left behind. Defensive, matching every other structurally-validated
    // field in this loader — a malformed combination is dropped, not trusted.
    const orphanedFlag = JSON.stringify({
      version: 1,
      config: { schema: sampleSchema },
      papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', abstractFromPdf: true, annotations: {} }],
    })
    const project = loadProject(orphanedFlag)
    expect(project.papers[0].abstract).toBeUndefined()
    expect(project.papers[0].abstractFromPdf).toBeUndefined()
    const reserialized = JSON.parse(serializeProject(project))
    expect('abstractFromPdf' in reserialized.papers[0]).toBe(false)
  })

  it('never writes abstractFromPdf for an ordinary typed or imported abstract', () => {
    const project = loadProject(
      JSON.stringify({
        version: 1,
        config: { schema: sampleSchema },
        papers: [
          { id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', abstract: 'Typed by a human.', annotations: {} },
        ],
      }),
    )
    const out = JSON.parse(serializeProject(project))
    expect('abstractFromPdf' in out.papers[0]).toBe(false)
  })

  it('a single-reviewer non-screening project carries no screening/abstract artifacts and round-trips byte-identically', () => {
    const project = loadProject(makeProjectJson({ 'Study Type': [{ value: 'RCT' }] }))
    const out = JSON.parse(serializeProject(project)) as { config: Record<string, unknown>; papers: Record<string, unknown>[] }
    expect('screening' in out.config).toBe(false)
    expect('abstract' in out.papers[0]).toBe(false)
    // The critical backwards-compatibility guarantee: this feature's presence
    // in the codebase must not perturb a single-reviewer, non-screening
    // file's serialization in any way — re-loading and re-serializing is a
    // no-op, exactly as it was before this feature existed.
    const once = serializeProject(project)
    expect(serializeProject(loadProject(once))).toBe(once)
  })
})

describe('Project.provenance (where an imported project came from)', () => {
  const VALID_PROVENANCE = {
    kind: 'screening-import',
    source: { file: 'screening.json', title: 'My Review' },
    importedAt: '2026-07-15T10:00:00.000Z',
    counts: { included: 3, undecided: 1, excluded: 2, carried: 4 },
  }

  const withProvenance = (provenance: unknown) =>
    JSON.stringify({
      version: 1,
      config: { schema: sampleSchema },
      ...(provenance === undefined ? {} : { provenance }),
      papers: [{ id: 'p1', title: 'Some Paper', authors: [], pdf: 'pdfs/some.pdf', annotations: {} }],
    })

  it('is null when the project was never imported', () => {
    expect(loadProject(withProvenance(undefined)).provenance).toBeNull()
  })

  it('loads a well-formed record', () => {
    expect(loadProject(withProvenance(VALID_PROVENANCE)).provenance).toEqual(VALID_PROVENANCE)
  })

  it('a source with no title loads fine — title is optional, unlike file', () => {
    const noTitle = { ...VALID_PROVENANCE, source: { file: 'screening.json' } }
    expect(loadProject(withProvenance(noTitle)).provenance).toEqual(noTitle)
  })

  it('round-trips through load -> serialize -> reload', () => {
    const once = serializeProject(loadProject(withProvenance(VALID_PROVENANCE)))
    expect(loadProject(once).provenance).toEqual(VALID_PROVENANCE)
  })

  it('is written only when present, so an ordinary (non-imported) project stays byte-clean', () => {
    const untouched = JSON.parse(serializeProject(loadProject(withProvenance(undefined))))
    expect('provenance' in untouched).toBe(false)

    const imported = JSON.parse(serializeProject(loadProject(withProvenance(VALID_PROVENANCE))))
    expect(imported.provenance).toEqual(VALID_PROVENANCE)
  })

  it('a pre-existing file with no provenance re-serializes with no provenance key — back-compat', () => {
    const out = JSON.parse(serializeProject(loadProject(withProvenance(undefined))))
    expect('provenance' in out).toBe(false)
  })

  it('drops a malformed record rather than failing the whole file to load, and never reappears under extra', () => {
    // The file is hand-editable, so a broken record must degrade to "no
    // provenance", the same rule aiUsage/reviews/equal follow — never thrown
    // over, and never silently repaired into something it didn't earn.
    const cases: unknown[] = [
      'nonsense',
      42,
      [],
      {
        kind: 'bogus',
        source: { file: 'x.json' },
        importedAt: 't',
        counts: { included: 0, undecided: 0, excluded: 0, carried: 0 },
      },
      { kind: 'screening-import', source: { file: 'x.json' }, importedAt: 't' }, // counts missing
      {
        kind: 'screening-import',
        source: {}, // file missing
        importedAt: 't',
        counts: { included: 0, undecided: 0, excluded: 0, carried: 0 },
      },
      {
        kind: 'screening-import',
        source: { file: 'x.json' },
        importedAt: 't',
        counts: { included: 0, undecided: 0, excluded: 0, carried: '3' }, // wrong type
      },
      {
        kind: 'screening-import',
        source: { file: 'x.json' },
        importedAt: 42, // wrong type
        counts: { included: 0, undecided: 0, excluded: 0, carried: 0 },
      },
    ]
    for (const bad of cases) {
      const project = loadProject(withProvenance(bad))
      expect(project.provenance).toBeNull()
      expect('provenance' in project.extra).toBe(false)
      const out = JSON.parse(serializeProject(project))
      expect('provenance' in out).toBe(false)
    }
  })

  it('does not leak into extra, and the saved file has exactly one provenance key', () => {
    const project = loadProject(withProvenance(VALID_PROVENANCE))
    expect('provenance' in project.extra).toBe(false)
    const out = JSON.parse(serializeProject(project))
    expect(Object.keys(out).filter((k) => k === 'provenance')).toHaveLength(1)
  })

  it('config.provenance is not a thing — nesting it under config silently loses it on save', () => {
    // config is z.object({...}) without .passthrough(), and serializeProject
    // rebuilds config from four known fields — anything else placed there is
    // dropped on the very first save. Pinned here so nobody "fixes" this by
    // relocating the field.
    const text = JSON.stringify({
      version: 1,
      config: { schema: sampleSchema, provenance: VALID_PROVENANCE },
      papers: [{ id: 'p1', title: 'Some Paper', authors: [], pdf: 'pdfs/some.pdf', annotations: {} }],
    })
    const project = loadProject(text)
    expect(project.provenance).toBeNull()
    const out = JSON.parse(serializeProject(project)) as { config: Record<string, unknown> }
    expect('provenance' in out.config).toBe(false)
  })
})

describe('Project.protocol (the review protocol)', () => {
  const VALID_PROTOCOL = {
    researchQuestions: ['RQ1: What techniques?', 'RQ2: How evaluated?'],
    searchStrings: ['("code search" AND "deep learning")'],
    databases: ['Scopus', 'IEEE Xplore'],
    searchDate: '2024-03',
    notes: 'English, peer-reviewed, since 2015.',
  }

  const withProtocol = (protocol: unknown) =>
    JSON.stringify({
      version: 1,
      config: { schema: sampleSchema },
      ...(protocol === undefined ? {} : { protocol }),
      papers: [{ id: 'p1', title: 'Some Paper', authors: [], pdf: 'pdfs/some.pdf', annotations: {} }],
    })

  it('is null when the project records none', () => {
    expect(loadProject(withProtocol(undefined)).protocol).toBeNull()
  })

  it('loads a well-formed record', () => {
    expect(loadProject(withProtocol(VALID_PROTOCOL)).protocol).toEqual(VALID_PROTOCOL)
  })

  it('round-trips through load -> serialize -> reload', () => {
    const once = serializeProject(loadProject(withProtocol(VALID_PROTOCOL)))
    expect(loadProject(once).protocol).toEqual(VALID_PROTOCOL)
  })

  it('is written only when present, so a project without a protocol stays byte-clean', () => {
    const untouched = JSON.parse(serializeProject(loadProject(withProtocol(undefined))))
    expect('protocol' in untouched).toBe(false)
  })

  it('degrades field by field, not all-or-nothing — a bad list keeps the good fields beside it', () => {
    // Unlike provenance (rejected whole on any bad piece), an authored protocol
    // drops only the malformed field: losing the databases list should never
    // throw away the research questions typed next to it.
    const partlyBad = {
      researchQuestions: ['RQ1'],
      databases: 'Scopus', // should be an array — dropped
      searchDate: 42, // wrong type — dropped
      notes: 'kept',
    }
    expect(loadProject(withProtocol(partlyBad)).protocol).toEqual({
      researchQuestions: ['RQ1'],
      notes: 'kept',
    })
  })

  it('drops blank entries and whitespace, and an all-empty protocol becomes null', () => {
    const blanks = { researchQuestions: ['  ', ''], searchStrings: [], notes: '   ' }
    expect(loadProject(withProtocol(blanks)).protocol).toBeNull()
    const out = JSON.parse(serializeProject(loadProject(withProtocol(blanks))))
    expect('protocol' in out).toBe(false)
  })

  it('drops a wholly malformed record and never lets it reappear under extra', () => {
    for (const bad of ['nonsense', 42, [], null] as unknown[]) {
      const project = loadProject(withProtocol(bad))
      expect(project.protocol).toBeNull()
      expect('protocol' in project.extra).toBe(false)
      expect('protocol' in JSON.parse(serializeProject(project))).toBe(false)
    }
  })

  it('config.protocol is a trap — nesting it under config silently loses it on save', () => {
    // The whole reason this field is root-level: config is a strict z.object
    // rebuilt from scratch on save, so a hand-added config.protocol vanishes.
    // Pinned so nobody "tidies" it back under config.
    const text = JSON.stringify({
      version: 1,
      config: { schema: sampleSchema, protocol: VALID_PROTOCOL },
      papers: [{ id: 'p1', title: 'Some Paper', authors: [], pdf: 'pdfs/some.pdf', annotations: {} }],
    })
    const project = loadProject(text)
    expect(project.protocol).toBeNull()
    const out = JSON.parse(serializeProject(project)) as { config: Record<string, unknown> }
    expect('protocol' in out.config).toBe(false)
  })
})

describe('hand-edited value tree with primitive instances does not crash the loader', () => {
  // Regression: `normalizeInstance` used `'value' in inst` unguarded, which
  // throws a raw TypeError on a primitive — escaping loadProject's contract to
  // only ever raise ProjectLoadError, and (worse) aborting a git pull-merge
  // that loads such a revision.
  const schema: AnnotationDef[] = [
    { name: 'Study Type', type: 'string' },
    { name: 'Count', type: 'number' },
    { name: 'Relevant', type: 'boolean' },
  ]
  const withInstances = (anno: Record<string, unknown>) =>
    JSON.stringify({
      version: 1,
      config: { schema },
      papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: anno }],
    })

  it.each([
    ['string', { 'Study Type': ['RCT'] }],
    ['number', { Count: [42] }],
    ['boolean', { Relevant: [true] }],
  ])('normalizes a bare %s instance instead of throwing', (_kind, anno) => {
    expect(() => loadProject(withInstances(anno))).not.toThrow()
    const p = loadProject(withInstances(anno))
    // The malformed shorthand loses its value (degraded to the empty skeleton),
    // but the file opens and re-serializes cleanly — the defensiveness the
    // module's own doc comment promises.
    expect(() => serializeProject(p)).not.toThrow()
  })
})

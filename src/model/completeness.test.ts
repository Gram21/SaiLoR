import { describe, it, expect } from 'vitest'
import { loadProject, serializeProject, type Project } from './project'
import type { AnnotationDef } from './schema'
import { completeness, completenessPercent, hasRequiredFields } from './completeness'

/**
 * Fixtures are built through `loadProject` (the real load path), matching the
 * rule `git/merge.test.ts` sets: every schema and tree here is exactly as
 * resolved/normalized as what the app itself would hand `completeness`.
 */

const SIMPLE: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Year', type: 'number' },
  { name: 'Notes', type: 'string' },
]

const MIXED_REQUIRED: AnnotationDef[] = [
  { name: 'Claim', type: 'string', required: true },
  { name: 'Evidence', type: 'string', required: true },
  { name: 'Notes', type: 'string' },
  { name: 'Year', type: 'number' },
]

const WITH_BOOLEAN: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Relevant', type: 'boolean' },
]

const BOOLEAN_ONLY: AnnotationDef[] = [{ name: 'Relevant', type: 'boolean' }]

const REPEAT_UNBOUNDED: AnnotationDef[] = [
  { name: 'Findings', max: null, children: [{ name: 'Claim', type: 'string', required: true }] },
]

const MIN_ZERO: AnnotationDef[] = [
  {
    name: 'Optional Group',
    min: 0,
    children: [{ name: 'Detail', type: 'string', required: true }],
  },
]

const DEEP: AnnotationDef[] = [
  {
    name: 'Outer',
    children: [
      {
        name: 'Inner',
        children: [{ name: 'Value', type: 'string', required: true }],
      },
    ],
  },
]

function project(schemaDefs: AnnotationDef[], annotations?: Record<string, unknown>): Project {
  return loadProject({
    version: 1,
    config: { schema: schemaDefs },
    papers: [
      {
        id: 'p1',
        title: 'Paper 1',
        authors: [],
        pdf: 'p1.pdf',
        annotations: annotations ?? {},
      },
    ],
  })
}

describe('hasRequiredFields', () => {
  it('is false when nothing in the schema is required', () => {
    expect(hasRequiredFields(project(SIMPLE).schema)).toBe(false)
  })

  it('is true when a top-level field is required', () => {
    expect(hasRequiredFields(project(MIXED_REQUIRED).schema)).toBe(true)
  })

  it('is true when the only required field is nested two groups deep', () => {
    // Guards against a walk that only checks the top level.
    expect(hasRequiredFields(project(DEEP).schema)).toBe(true)
  })
})

describe('completeness — denominator mode', () => {
  it('counts every field when nothing is required', () => {
    const p = project(SIMPLE)
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 0, total: 3 })
  })

  it('counts only required fields when the schema marks any required, and filling an optional field moves neither number', () => {
    const p = project(MIXED_REQUIRED, {
      Claim: [{ value: 'X causes Y' }],
      Notes: [{ value: 'an optional note' }],
    })
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 1, total: 2 })
  })

  it('the headline bug this module fixes: 1 of 12 filled is not equal to 12 of 12', () => {
    const twelve: AnnotationDef[] = Array.from({ length: 12 }, (_, i) => ({
      name: `Field ${i}`,
      type: 'string' as const,
    }))
    const p = project(twelve, { 'Field 0': [{ value: 'answered' }] })
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 1, total: 12 })
    expect(c.filled).not.toBe(c.total)
  })
})

describe('completeness — booleans', () => {
  it('a boolean at true and at false leave filled/total identical', () => {
    const p = project(WITH_BOOLEAN)
    const untouched = completeness(p.schema, p.papers[0].annotations)

    const withTrue = { ...p.papers[0].annotations, Relevant: [{ value: true }] }
    const withFalse = { ...p.papers[0].annotations, Relevant: [{ value: false }] }
    expect(completeness(p.schema, withTrue)).toEqual(untouched)
    expect(completeness(p.schema, withFalse)).toEqual(untouched)
  })

  it('a boolean-only schema has nothing countable', () => {
    const p = project(BOOLEAN_ONLY, { Relevant: [{ value: true }] })
    expect(completeness(p.schema, p.papers[0].annotations)).toEqual({ filled: 0, total: 0 })
  })
})

describe('completeness — emptiness', () => {
  it('empty string, whitespace-only, null, and undefined are all empty; 0 is filled', () => {
    const defs: AnnotationDef[] = [
      { name: 'A', type: 'string' },
      { name: 'B', type: 'string' },
      { name: 'C', type: 'string' },
      { name: 'D', type: 'number' },
    ]
    const p = project(defs, {
      A: [{ value: '' }],
      B: [{ value: '   ' }],
      C: [{ value: null }],
      D: [{ value: 0 }],
    })
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 1, total: 4 })
  })
})

describe('completeness — repeatables', () => {
  it('one filled instance of an unbounded group is 1/1', () => {
    const p = project(REPEAT_UNBOUNDED, {
      Findings: [{ children: { Claim: [{ value: 'a claim' }] } }],
    })
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 1, total: 1 })
  })

  it('adding a second, empty instance dips the ratio to 1/2 — a deliberate transient dip', () => {
    const p = project(REPEAT_UNBOUNDED, {
      Findings: [{ children: { Claim: [{ value: 'a claim' }] } }, { children: { Claim: [{ value: null }] } }],
    })
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 1, total: 2 })
  })

  it('filling the second instance recovers 2/2', () => {
    const p = project(REPEAT_UNBOUNDED, {
      Findings: [
        { children: { Claim: [{ value: 'a claim' }] } },
        { children: { Claim: [{ value: 'another claim' }] } },
      ],
    })
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 2, total: 2 })
  })

  it('a min:0 group is still padded to one instance by normalizeTree, and its required child counts', () => {
    const p = project(MIN_ZERO)
    const c = completeness(p.schema, p.papers[0].annotations)
    expect(c).toEqual({ filled: 0, total: 1 })
  })
})

describe('completeness — round-trip through save', () => {
  it('a tree with trailing empty instances has a lower ratio before save, and recovers after — tracking pruneTree', () => {
    const p = project(REPEAT_UNBOUNDED, {
      Findings: [{ children: { Claim: [{ value: 'a claim' }] } }, { children: { Claim: [{ value: null }] } }],
    })
    const before = completeness(p.schema, p.papers[0].annotations)
    expect(before).toEqual({ filled: 1, total: 2 })

    const reloaded = loadProject(serializeProject(p))
    const after = completeness(reloaded.schema, reloaded.papers[0].annotations)
    expect(after).toEqual({ filled: 1, total: 1 })
  })
})

describe('completeness — adversarial input (must never throw)', () => {
  const p = project(SIMPLE)

  it('an empty annotations object', () => {
    expect(() => completeness(p.schema, {})).not.toThrow()
    expect(completeness(p.schema, {})).toEqual({ filled: 0, total: 0 })
  })

  it('null/undefined tree', () => {
    expect(completeness(p.schema, null)).toEqual({ filled: 0, total: 0 })
    expect(completeness(p.schema, undefined)).toEqual({ filled: 0, total: 0 })
  })

  it('a node key holding the wrong shape (object, NaN, missing) is skipped, not thrown', () => {
    const tree = {
      'Study Type': { not: 'an array' } as unknown as never,
      Year: [{ value: NaN }],
      // Notes is entirely absent.
    }
    expect(() => completeness(p.schema, tree)).not.toThrow()
    const c = completeness(p.schema, tree)
    // "Study Type" contributes nothing (malformed instances list), "Year"
    // counts (NaN is a real, if odd, number value — not `isEmptyValue`'s
    // job to reject it), "Notes" contributes nothing (no instances present).
    expect(c).toEqual({ filled: 1, total: 1 })
  })

  it('an instance that is null or a bare string instead of an object is skipped', () => {
    const tree = { 'Study Type': [null, 'not an object'] as unknown as never }
    expect(() => completeness(p.schema, tree)).not.toThrow()
    expect(completeness(p.schema, tree)).toEqual({ filled: 0, total: 0 })
  })

  it('a tree key not present in the schema is ignored', () => {
    const tree = { 'Not In Schema': [{ value: 'x' }] } as unknown as never
    expect(completeness(p.schema, tree)).toEqual({ filled: 0, total: 0 })
  })
})

describe('completenessPercent', () => {
  it('total 0 is null (degenerate — callers fall back to the binary dot)', () => {
    expect(completenessPercent({ filled: 0, total: 0 })).toBeNull()
  })

  it('0/12 is exactly 0, 12/12 is exactly 100', () => {
    expect(completenessPercent({ filled: 0, total: 12 })).toBe(0)
    expect(completenessPercent({ filled: 12, total: 12 })).toBe(100)
  })

  it('199/200 never rounds up to 100', () => {
    expect(completenessPercent({ filled: 199, total: 200 })).toBe(99)
  })

  it('1/200 never rounds down to 0', () => {
    expect(completenessPercent({ filled: 1, total: 200 })).toBe(5)
  })

  it('a middling ratio floors normally, unaffected by the clamps', () => {
    expect(completenessPercent({ filled: 1, total: 4 })).toBe(25)
  })
})

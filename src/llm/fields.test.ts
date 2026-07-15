import { describe, it, expect } from 'vitest'
import { resolveSchema, type ResolvedDef } from '../model/schema'
import { initTree, normalizeTree, type AnnotationValueTree } from '../model/annotations'
import { isEmptyValue } from '../model/validate'
import { isUnanswered, unansweredFields } from './fields'

// ---------------------------------------------------------------------------
// Schemas come from resolveSchema and trees from initTree/normalizeTree, so the
// tests run against the exact shapes the app produces at runtime.
// ---------------------------------------------------------------------------

const schema: ResolvedDef[] = resolveSchema([
  { name: 'Relevant', type: 'boolean' },
  { name: 'Study Type', type: 'string', options: ['RCT', 'Survey'] },
  { name: 'Year', type: 'number' },
  {
    name: 'Findings',
    min: 1,
    max: null,
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
])

/** The field defs of `schema`, by name, for the isUnanswered unit tests. */
function fieldDef(name: 'Relevant' | 'Study Type' | 'Year'): ResolvedDef {
  return schema.find((d) => d.name === name)!
}

const boolDef = fieldDef('Relevant')
const stringDef = fieldDef('Study Type')
const numberDef = fieldDef('Year')

function paths(tree: AnnotationValueTree | undefined): string[] {
  return unansweredFields(schema, tree).map((t) => t.path)
}

// ---------------------------------------------------------------------------
// isUnanswered
// ---------------------------------------------------------------------------

describe('isUnanswered: strings', () => {
  it('treats null, undefined, empty and whitespace-only as unanswered', () => {
    expect(isUnanswered(stringDef, null)).toBe(true)
    expect(isUnanswered(stringDef, undefined)).toBe(true)
    expect(isUnanswered(stringDef, '')).toBe(true)
    // Whitespace is invisible in the UI, so it is not an answer.
    expect(isUnanswered(stringDef, '   ')).toBe(true)
  })

  it('treats any non-blank text as answered', () => {
    expect(isUnanswered(stringDef, 'x')).toBe(false)
    expect(isUnanswered(stringDef, 'RCT')).toBe(false)
    // "0" is text a reviewer typed; it is an answer.
    expect(isUnanswered(stringDef, '0')).toBe(false)
  })
})

describe('isUnanswered: numbers', () => {
  it('treats null and undefined as unanswered', () => {
    expect(isUnanswered(numberDef, null)).toBe(true)
    expect(isUnanswered(numberDef, undefined)).toBe(true)
  })

  // 0 is a perfectly good measurement. Asking the AI to "fill" it would invite
  // it to overwrite a real answer, so it must count as answered.
  it('treats 0 as ANSWERED, not as empty', () => {
    expect(isUnanswered(numberDef, 0)).toBe(false)
    expect(isUnanswered(numberDef, 2021)).toBe(false)
  })
})

describe('isUnanswered: booleans', () => {
  // This is the one place where isUnanswered deliberately DIVERGES from
  // validate.ts's isEmptyValue, and the divergence is the whole point of the
  // function. The data model cannot express an *unanswered* boolean: an untouched
  // checkbox and a deliberate "no" are both `false`. isEmptyValue therefore says a
  // boolean is never empty (so a required boolean is never reported as missing).
  // If the AI layer reused that rule it could never propose a boolean at all —
  // not even the archetypal "Relevant". So here a boolean counts as unanswered
  // until it is ticked: the AI may propose flipping it to true, never to false,
  // and can never silently clear a box the reviewer ticked.
  it('treats false, null and undefined as UNANSWERED (unlike isEmptyValue)', () => {
    expect(isUnanswered(boolDef, false)).toBe(true)
    expect(isUnanswered(boolDef, null)).toBe(true)
    expect(isUnanswered(boolDef, undefined)).toBe(true)

    // Pin the divergence itself, so a "simplification" that reuses isEmptyValue fails.
    expect(isEmptyValue('boolean', false)).toBe(false)
    expect(isEmptyValue('boolean', null)).toBe(false)
  })

  it('treats true as answered', () => {
    expect(isUnanswered(boolDef, true)).toBe(false)
    expect(isEmptyValue('boolean', true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// unansweredFields
// ---------------------------------------------------------------------------

describe('unansweredFields: a freshly initialised tree', () => {
  it('lists every field, in schema order, with canonical paths', () => {
    // initTree gives strings/numbers `null` and booleans `false` — all unanswered.
    expect(paths(initTree(schema))).toEqual([
      'Relevant',
      'Study Type',
      'Year',
      'Findings/Claim',
      'Findings/Evidence/Metric',
    ])
  })

  it('reports the def and current value alongside each path', () => {
    const targets = unansweredFields(schema, initTree(schema))
    expect(targets[0]).toMatchObject({ path: 'Relevant', value: false })
    expect(targets[0].def.id).toBe('Relevant')
    expect(targets[1]).toMatchObject({ path: 'Study Type', value: null })
    expect(targets[1].def.options).toEqual(['RCT', 'Survey'])
    // The nested field's def is the resolved child def, not the group's.
    expect(targets[4].def.id).toBe('Findings/Evidence/Metric')
  })

  // Groups carry no value of their own, so they are never targets.
  it('never lists a group node', () => {
    expect(paths(initTree(schema))).not.toContain('Findings')
    expect(paths(initTree(schema))).not.toContain('Findings/Evidence')
  })
})

describe('unansweredFields: answered fields are omitted', () => {
  it('omits fields that already hold a value', () => {
    const tree = normalizeTree(schema, {
      'Study Type': [{ value: 'RCT' }],
      Year: [{ value: 2021 }],
    })
    expect(paths(tree)).toEqual(['Relevant', 'Findings/Claim', 'Findings/Evidence/Metric'])
  })

  it('treats 0 as an answer but blank text as none', () => {
    const tree = normalizeTree(schema, {
      Year: [{ value: 0 }],
      'Study Type': [{ value: '  ' }],
    })
    expect(paths(tree)).toContain('Study Type')
    expect(paths(tree)).not.toContain('Year')
  })

  it('omits a boolean that is already true and lists one that is false', () => {
    expect(paths(normalizeTree(schema, { Relevant: [{ value: true }] }))).not.toContain('Relevant')
    expect(paths(normalizeTree(schema, { Relevant: [{ value: false }] }))).toContain('Relevant')
  })

  it('returns [] when every field is answered', () => {
    const tree = normalizeTree(schema, {
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
    })
    expect(unansweredFields(schema, tree)).toEqual([])
  })
})

describe('unansweredFields: repeated instances', () => {
  it('indexes the second instance and leaves the first index implicit', () => {
    // Two Findings; normalizeTree fills each one out to the schema.
    const tree = normalizeTree(schema, { Findings: [{}, {}] })
    expect(paths(tree)).toEqual([
      'Relevant',
      'Study Type',
      'Year',
      'Findings/Claim',
      'Findings/Evidence/Metric',
      'Findings[1]/Claim',
      'Findings[1]/Evidence/Metric',
    ])
  })

  it('indexes nested repeats independently of their parent', () => {
    const tree = normalizeTree(schema, {
      Findings: [
        { children: { Claim: [{ value: 'first' }], Evidence: [{}, {}] } },
        { children: { Claim: [{ value: 'second' }], Evidence: [{}] } },
      ],
    })
    expect(paths(tree)).toEqual([
      'Relevant',
      'Study Type',
      'Year',
      // "first" and "second" are answered, so only the Metrics remain.
      'Findings/Evidence/Metric',
      'Findings/Evidence[1]/Metric',
      'Findings[1]/Evidence/Metric',
    ])
  })

  it('walks only the instances that exist; further ones are for the model to name', () => {
    // One Findings instance means one Claim target, even though Findings is
    // unbounded — resolvePath is what lets the model reach Findings[1] later.
    const tree = normalizeTree(schema, { Findings: [{}] })
    expect(paths(tree).filter((p) => p.endsWith('Claim'))).toEqual(['Findings/Claim'])
  })
})

describe('unansweredFields: malformed or partial trees', () => {
  // The project JSON is hand-editable, so the walker must never throw on it.
  it('treats an undefined tree as "nothing answered"', () => {
    expect(() => unansweredFields(schema, undefined)).not.toThrow()
    expect(paths(undefined)).toEqual([
      'Relevant',
      'Study Type',
      'Year',
      'Findings/Claim',
      'Findings/Evidence/Metric',
    ])
  })

  it('treats an empty tree the same way', () => {
    expect(paths({})).toEqual([
      'Relevant',
      'Study Type',
      'Year',
      'Findings/Claim',
      'Findings/Evidence/Metric',
    ])
  })

  it('fills in missing keys around the ones that are present', () => {
    // Only "Year" is present, and Findings has no `children` at all.
    const tree: AnnotationValueTree = { Year: [{ value: 1999 }], Findings: [{}] }
    expect(paths(tree)).toEqual([
      'Relevant',
      'Study Type',
      'Findings/Claim',
      'Findings/Evidence/Metric',
    ])
  })

  it('survives null instances and null children', () => {
    const tree = {
      Relevant: [null],
      Findings: [{ children: null }],
    } as unknown as AnnotationValueTree
    expect(() => unansweredFields(schema, tree)).not.toThrow()
    expect(paths(tree)).toEqual([
      'Relevant',
      'Study Type',
      'Year',
      'Findings/Claim',
      'Findings/Evidence/Metric',
    ])
  })

  it('ignores keys that are not in the schema', () => {
    const tree = { Bogus: [{ value: 'x' }] } as unknown as AnnotationValueTree
    expect(paths(tree)).not.toContain('Bogus')
  })

  // NOTE: a node key holding a non-array (e.g. `{"Findings": {"value": "x"}}`,
  // which validate.ts explicitly tolerates and reports as a 'type' issue) makes
  // `walk` throw "instances.forEach is not a function". Not covered here because
  // fixing it means touching fields.ts; reported separately.

  it('returns [] for an empty schema', () => {
    expect(unansweredFields([], initTree(schema))).toEqual([])
  })
})

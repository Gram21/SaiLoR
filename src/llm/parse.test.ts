import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { parseAnswer } from './parse'
import type { LlmAnswer } from './types'

// ---------------------------------------------------------------------------
// A schema with one node of each shape the parser has to reason about. It goes
// through resolveSchema so the defaults (min/max/required) are the real ones.
// ---------------------------------------------------------------------------

const schema = resolveSchema([
  { name: 'Summary', type: 'string' },
  { name: 'Year', type: 'number' },
  { name: 'Relevant', type: 'boolean' },
  { name: 'Study Type', type: 'string', options: ['Randomized', 'Observational', 'Case Study'] },
  {
    name: 'Findings',
    max: 2,
    children: [
      { name: 'Claim', type: 'string' },
      // A group inside a repeatable group: the deepest path the parser can see.
      { name: 'Evidence', max: 2, children: [{ name: 'Metric', type: 'number' }] },
    ],
  },
])

/** Shorthand for the common "one field, nothing else" answer. */
function one(path: string, value: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ fields: [{ path, value, ...extra }] })
}

function reasons(answer: LlmAnswer): string[] {
  return answer.rejected.map((r) => r.reason)
}

describe('JSON extraction', () => {
  it('parses a clean answer', () => {
    const raw = JSON.stringify({
      fields: [{ path: 'Year', value: 2021, evidence: 'published in 2021', confidence: 0.9 }],
      skipped: [{ path: 'Summary', reason: 'not stated' }],
    })

    const answer = parseAnswer(schema, raw)
    expect(answer.fields).toEqual([
      { path: 'Year', value: 2021, evidence: 'published in 2021', confidence: 0.9 },
    ])
    expect(answer.skipped).toEqual([{ path: 'Summary', reason: 'not stated' }])
    expect(answer.rejected).toEqual([])
  })

  it('strips a ```json fence', () => {
    const raw = ['```json', one('Year', 2021), '```'].join('\n')
    expect(parseAnswer(schema, raw).fields[0].value).toBe(2021)
  })

  it('strips a fence that was never closed', () => {
    const raw = `\`\`\`json\n${one('Year', 2021)}`
    expect(parseAnswer(schema, raw).fields[0].value).toBe(2021)
  })

  it('ignores prose before and after the object', () => {
    const raw = `Here is the JSON:\n${one('Year', 2021)}\nHope that helps!`
    expect(parseAnswer(schema, raw).fields[0].value).toBe(2021)
  })

  it('keeps scanning past a stray brace in the prose', () => {
    const raw = `The value {curly} is fine.\n${one('Year', 2021)}`
    expect(parseAnswer(schema, raw).fields[0].value).toBe(2021)
  })

  it('does not stop at a brace inside a string value', () => {
    // The regex-shaped trap: the first `}` in the text belongs to the quote.
    const evidence = 'the set {a, b} was excluded'
    const raw = `Sure!\n${one('Year', 2021, { evidence })}\nDone.`

    const answer = parseAnswer(schema, raw)
    expect(answer.fields).toHaveLength(1)
    expect(answer.fields[0].evidence).toBe(evidence)
  })

  it('handles escaped quotes and braces inside a string value', () => {
    const evidence = 'they wrote "n = {5}\\" in the table'
    const answer = parseAnswer(schema, one('Year', 2021, { evidence }))
    expect(answer.fields[0].evidence).toBe(evidence)
  })
})

describe('unparseable input', () => {
  const empty: LlmAnswer = { fields: [], skipped: [], rejected: [] }

  it('returns an empty answer for total garbage', () => {
    expect(parseAnswer(schema, 'I am sorry, I cannot help with that.')).toEqual(empty)
  })

  it('returns an empty answer for an unbalanced object', () => {
    expect(parseAnswer(schema, '{ "fields": [ { "path": "Year"')).toEqual(empty)
  })

  it('returns an empty answer for an empty string', () => {
    expect(parseAnswer(schema, '')).toEqual(empty)
  })

  it('returns an empty answer for null / undefined input', () => {
    // The transport layer is typed, but a provider that returns no text at all
    // must not take the app down.
    expect(parseAnswer(schema, null as unknown as string)).toEqual(empty)
    expect(parseAnswer(schema, undefined as unknown as string)).toEqual(empty)
  })

  it('tolerates a missing or mistyped "fields" key', () => {
    expect(parseAnswer(schema, '{}')).toEqual(empty)
    expect(parseAnswer(schema, '{ "fields": "none" }')).toEqual(empty)
  })
})

describe('path validation', () => {
  it('accepts a path into a nested repeatable group', () => {
    const answer = parseAnswer(schema, one('Findings[1]/Evidence[1]/Metric', 42))
    expect(answer.fields[0]).toMatchObject({ path: 'Findings[1]/Evidence[1]/Metric', value: 42 })
  })

  it('rejects an unknown field', () => {
    const answer = parseAnswer(schema, one('Funding Source', 'NSF'))
    expect(answer.fields).toEqual([])
    expect(answer.rejected).toEqual([
      { path: 'Funding Source', raw: 'NSF', reason: 'unknown field' },
    ])
  })

  it('rejects a group path, which carries no value', () => {
    const answer = parseAnswer(schema, one('Findings', 'a lot'))
    expect(answer.fields).toEqual([])
    expect(reasons(answer)).toEqual(['unknown field'])
  })

  it('rejects an index beyond the node max', () => {
    // Findings has max 2, so [2] is the third entry.
    const answer = parseAnswer(schema, one('Findings[2]/Claim', 'third'))
    expect(answer.fields).toEqual([])
    expect(reasons(answer)).toEqual(['unknown field'])
  })

  it('rejects a missing or non-string path', () => {
    const raw = JSON.stringify({ fields: [{ value: 2021 }, { path: 7, value: 2021 }] })
    expect(reasons(parseAnswer(schema, raw))).toEqual(['unknown field', 'unknown field'])
  })

  it('rejects an entry that is not an object', () => {
    const raw = JSON.stringify({ fields: ['Year', null] })
    expect(reasons(parseAnswer(schema, raw))).toEqual(['malformed entry', 'malformed entry'])
  })
})

describe('type checking', () => {
  it('accepts a string and trims it', () => {
    expect(parseAnswer(schema, one('Summary', '  a study  ')).fields[0].value).toBe('a study')
  })

  it('rejects a non-string for a string field', () => {
    expect(reasons(parseAnswer(schema, one('Summary', 7)))).toEqual(['not a string'])
  })

  it('rejects an empty string', () => {
    expect(reasons(parseAnswer(schema, one('Summary', '   ')))).toEqual(['empty value'])
  })

  it('accepts a JSON number', () => {
    expect(parseAnswer(schema, one('Year', 2021)).fields[0].value).toBe(2021)
  })

  it('coerces a numeric string to a number', () => {
    // Models quote numbers constantly; "2021" has exactly one reading.
    expect(parseAnswer(schema, one('Year', '2021')).fields[0].value).toBe(2021)
  })

  it('rejects a number the model hedged on', () => {
    expect(reasons(parseAnswer(schema, one('Year', 'about 20')))).toEqual(['not a number'])
  })

  it('rejects a non-numeric value for a number field', () => {
    expect(reasons(parseAnswer(schema, one('Year', '')))).toEqual(['not a number'])
    expect(reasons(parseAnswer(schema, one('Year', true)))).toEqual(['not a number'])
    expect(reasons(parseAnswer(schema, one('Year', null)))).toEqual(['not a number'])
  })

  it('accepts booleans and their quoted spellings', () => {
    expect(parseAnswer(schema, one('Relevant', true)).fields[0].value).toBe(true)
    expect(parseAnswer(schema, one('Relevant', false)).fields[0].value).toBe(false)
    expect(parseAnswer(schema, one('Relevant', 'true')).fields[0].value).toBe(true)
    expect(parseAnswer(schema, one('Relevant', 'False')).fields[0].value).toBe(false)
  })

  it('rejects anything else for a boolean field', () => {
    expect(reasons(parseAnswer(schema, one('Relevant', 'yes')))).toEqual(['not a boolean'])
    expect(reasons(parseAnswer(schema, one('Relevant', 1)))).toEqual(['not a boolean'])
  })

  it('rejects a missing value', () => {
    const raw = JSON.stringify({ fields: [{ path: 'Year', evidence: 'p. 3' }] })
    expect(reasons(parseAnswer(schema, raw))).toEqual(['missing value'])
  })
})

describe('enums', () => {
  it('accepts an exact option', () => {
    expect(parseAnswer(schema, one('Study Type', 'Randomized')).fields[0].value).toBe('Randomized')
  })

  it('snaps a case- or whitespace-off answer onto the canonical option', () => {
    expect(parseAnswer(schema, one('Study Type', ' case study ')).fields[0].value).toBe(
      'Case Study',
    )
  })

  it('rejects a value that is not an option', () => {
    const answer = parseAnswer(schema, one('Study Type', 'Cohort'))
    expect(answer.fields).toEqual([])
    expect(answer.rejected).toEqual([
      { path: 'Study Type', raw: 'Cohort', reason: 'not an allowed value' },
    ])
  })
})

describe('evidence and confidence', () => {
  it('defaults missing evidence to an empty string', () => {
    expect(parseAnswer(schema, one('Year', 2021)).fields[0].evidence).toBe('')
    expect(parseAnswer(schema, one('Year', 2021, { evidence: null })).fields[0].evidence).toBe('')
    expect(parseAnswer(schema, one('Year', 2021, { evidence: {} })).fields[0].evidence).toBe('')
  })

  it('trims and caps evidence at 500 characters', () => {
    const evidence = ` ${'q'.repeat(600)} `
    expect(parseAnswer(schema, one('Year', 2021, { evidence })).fields[0].evidence).toHaveLength(500)
  })

  it('keeps a confidence inside 0..1', () => {
    expect(parseAnswer(schema, one('Year', 2021, { confidence: 0 })).fields[0].confidence).toBe(0)
    expect(parseAnswer(schema, one('Year', 2021, { confidence: 0.75 })).fields[0].confidence).toBe(
      0.75,
    )
  })

  it('nulls a confidence out of range or of the wrong shape', () => {
    // 95 could be percent, could be a 1..100 scale — we refuse to guess.
    for (const confidence of [95, -1, 1.5, 'high', null, {}]) {
      expect(parseAnswer(schema, one('Year', 2021, { confidence })).fields[0].confidence).toBeNull()
    }
  })

  it('nulls a missing confidence', () => {
    expect(parseAnswer(schema, one('Year', 2021)).fields[0].confidence).toBeNull()
  })
})

describe('duplicates', () => {
  it('keeps the first answer for a path and rejects the rest', () => {
    const raw = JSON.stringify({
      fields: [
        { path: 'Year', value: 2021 },
        // Same field, written the other way round: the canonical form dedupes them.
        { path: 'Year[0]', value: 1999 },
      ],
    })

    const answer = parseAnswer(schema, raw)
    expect(answer.fields).toHaveLength(1)
    expect(answer.fields[0].value).toBe(2021)
    expect(answer.rejected).toEqual([{ path: 'Year', raw: 1999, reason: 'duplicate' }])
  })

  it('does not let a rejected answer block a later good one', () => {
    const raw = JSON.stringify({
      fields: [
        { path: 'Year', value: 'about 20' },
        { path: 'Year', value: 2021 },
      ],
    })

    const answer = parseAnswer(schema, raw)
    expect(answer.fields).toEqual([{ path: 'Year', value: 2021, evidence: '', confidence: null }])
    expect(reasons(answer)).toEqual(['not a number'])
  })
})

describe('skipped', () => {
  it('keeps entries with a plausible path and a reason, and drops junk', () => {
    const raw = JSON.stringify({
      fields: [],
      skipped: [
        { path: 'Year', reason: 'not stated' },
        { path: 'Summary' },
        { path: '', reason: 'no path' },
        { path: 'Findings[1]/Claim', reason: 7 },
        'nonsense',
      ],
    })

    expect(parseAnswer(schema, raw).skipped).toEqual([{ path: 'Year', reason: 'not stated' }])
  })
})

describe('a mixed, realistic answer', () => {
  it('sorts every entry into fields, skipped or rejected', () => {
    const raw = [
      'Here is the JSON:',
      '```json',
      JSON.stringify({
        fields: [
          { path: 'Relevant', value: 'true', evidence: 'matches the criteria', confidence: 0.8 },
          { path: 'Year', value: '2021', confidence: 2 },
          { path: 'Study Type', value: 'randomized', evidence: 'an RCT {n=40}' },
          { path: 'Findings[1]/Claim', value: 'drug B helps' },
          { path: 'Funding Source', value: 'NSF' },
          { path: 'Study Type', value: 'Observational' },
        ],
        skipped: [{ path: 'Summary', reason: 'the paper has no abstract' }],
      }),
      '```',
      'Let me know if you need anything else.',
    ].join('\n')

    const answer = parseAnswer(schema, raw)

    expect(answer.fields).toEqual([
      { path: 'Relevant', value: true, evidence: 'matches the criteria', confidence: 0.8 },
      { path: 'Year', value: 2021, evidence: '', confidence: null },
      { path: 'Study Type', value: 'Randomized', evidence: 'an RCT {n=40}', confidence: null },
      { path: 'Findings[1]/Claim', value: 'drug B helps', evidence: '', confidence: null },
    ])
    expect(answer.skipped).toEqual([{ path: 'Summary', reason: 'the paper has no abstract' }])
    expect(answer.rejected).toEqual([
      { path: 'Funding Source', raw: 'NSF', reason: 'unknown field' },
      { path: 'Study Type', raw: 'Observational', reason: 'duplicate' },
    ])
  })
})

describe('coercion does not invent values the model never sent', () => {
  const schema = resolveSchema([
    { name: 'Count', type: 'number' },
    { name: 'Note', type: 'string' },
  ])

  it('rejects non-decimal number notations rather than reading them as numbers', () => {
    // A paper does not write a sample size in hexadecimal. `Number()` alone
    // reads all of these as numbers, which would silently record a value
    // nobody wrote; rejecting puts a visible row in front of the reviewer.
    for (const raw of ['0x20', '0b101', '0o17', '1_000', '   ', '', 'Infinity', '12px']) {
      const out = parseAnswer(schema, one('Count', raw))
      expect(out.fields.length, `${JSON.stringify(raw)} accepted`).toBe(0)
      expect(out.rejected.length, `${JSON.stringify(raw)} not reported`).toBe(1)
    }
  })

  it('still accepts the decimal spellings a paper actually uses', () => {
    for (const [raw, want] of [
      ['42', 42],
      ['-7', -7],
      ['3.5', 3.5],
      ['.5', 0.5],
      ['1e3', 1000],
      ['2.5E-2', 0.025],
      [' 42 ', 42],
    ] as const) {
      const out = parseAnswer(schema, one('Count', raw))
      expect(out.fields[0]?.value, JSON.stringify(raw)).toBe(want)
    }
  })

  it('reads an empty confidence as "none given", not as 0%', () => {
    // Number('') is 0, which sits inside the valid range, so an empty
    // confidence used to render as "0%" — a claim of total uncertainty the
    // model never made.
    for (const raw of ['', '   ']) {
      const out = parseAnswer(schema, one('Note', 'x', { confidence: raw }))
      expect(out.fields[0]?.confidence, JSON.stringify(raw)).toBeNull()
    }
    // A real zero still reads as zero.
    expect(parseAnswer(schema, one('Note', 'x', { confidence: 0 })).fields[0]?.confidence).toBe(0)
  })
})

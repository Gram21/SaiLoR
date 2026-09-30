import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { answeredFields, buildRecheckSystemPrompt, parseRecheckReply } from './recheck'

const schema = resolveSchema([
  { name: 'Year', type: 'number' },
  { name: 'Relevant', type: 'boolean' },
  { name: 'Type', type: 'string', options: ['RCT', 'Observational'] },
  { name: 'Findings', max: 2, children: [{ name: 'Claim', type: 'string' }] },
])
const tree = {
  Year: [{ value: 2021 }],
  Relevant: [{ value: false }],
  Type: [{ value: 'RCT' }],
  Findings: [
    { children: { Claim: [{ value: 'a' }] } },
    { children: { Claim: [{ value: '' }] } },
  ],
}
const targets = answeredFields(schema, tree)
const reply = (checks: unknown[]) => JSON.stringify({ checks })

describe('answeredFields', () => {
  it('lists filled fields incl. repeated nodes; false booleans and empties are unanswered', () => {
    expect(targets.map((t) => t.path)).toEqual(['Year', 'Type', 'Findings/Claim'])
    expect(targets[0].current).toBe(2021)
    const ticked = answeredFields(schema, { Relevant: [{ value: true }] })
    expect(ticked.map((t) => t.path)).toEqual(['Relevant'])
  })
})

describe('buildRecheckSystemPrompt', () => {
  it('shows current values and the schema remarks rule', () => {
    const p = buildRecheckSystemPrompt(schema, targets, 'text')
    expect(p).toContain('current value: 2021')
    expect(p).toContain('schema_remarks')
  })
})

describe('parseRecheckReply', () => {
  it('parses agree/disagree/unsure', () => {
    const { outcomes, rejected } = parseRecheckReply(
      schema,
      targets,
      reply([
        { path: 'Year', verdict: 'disagree', proposed: '2019', evidence: 'ICSE 2019', reason: 'says\n2019', confidence: 0.8 },
        { path: 'Type', verdict: 'agree', reason: 'ok' },
        { path: 'Findings/Claim', verdict: 'unsure', reason: 'unclear' },
      ]),
    )
    expect(rejected).toEqual([])
    expect(outcomes[0]).toMatchObject({ verdict: 'disagree', proposed: 2019, current: 2021, reason: 'says 2019', confidence: 0.8 })
    expect(outcomes.map((o) => o.verdict)).toEqual(['disagree', 'agree', 'unsure'])
  })

  it('downgrades unsupported disagreements to unsure', () => {
    const { outcomes } = parseRecheckReply(
      schema,
      targets,
      reply([
        { path: 'Year', verdict: 'disagree', proposed: 2019, reason: 'r' }, // no quote
        { path: 'Type', verdict: 'disagree', proposed: 'Nope', evidence: 'q', reason: 'r' }, // not an option
        { path: 'Findings/Claim', verdict: 'disagree', proposed: 'a', evidence: 'q', reason: 'r' }, // same
      ]),
    )
    expect(outcomes.every((o) => o.verdict === 'unsure' && o.proposed === undefined)).toBe(true)
    expect(outcomes[0].reason).toContain('no supporting quote')
  })

  it('rejects unasked, duplicate and junk; tolerates garbage', () => {
    const { outcomes, rejected } = parseRecheckReply(
      schema,
      targets,
      reply([
        { path: 'Relevant', verdict: 'agree' },
        { path: 'Nope', verdict: 'agree' },
        { path: 'Year', verdict: 'agree' },
        { path: 'Year[0]', verdict: 'agree' },
        { path: 'Type', verdict: 'maybe' },
        'x',
      ]),
    )
    expect(outcomes.map((o) => o.path)).toEqual(['Year'])
    expect(rejected.map((r) => r.reason)).toEqual([
      'field was not asked', 'field was not asked', 'duplicate', 'unknown verdict', 'malformed entry',
    ])
    expect(parseRecheckReply(schema, targets, 'not json').outcomes).toEqual([])
  })
})

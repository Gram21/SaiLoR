import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { buildJudgeSystemPrompt, buildJudgeUserMessage, parseJudgeReply } from './judge'
import { unansweredFields } from './fields'

const schema = resolveSchema([
  { name: 'Study Type', type: 'string', options: ['RCT', 'Observational'] },
  { name: 'Year', type: 'number' },
])
const targets = unansweredFields(schema, undefined)

describe('buildJudgeSystemPrompt / buildJudgeUserMessage', () => {
  it('includes the schema, path syntax and target fields', () => {
    const sys = buildJudgeSystemPrompt(schema, targets, 'text')
    expect(sys).toContain('Study Type')
    expect(sys).toContain('## Paths')
    expect(sys).toContain('verdicts')
  })

  it('lists each proposal with its value, source and evidence', () => {
    const msg = buildJudgeUserMessage([
      { path: 'Year', value: 2021, evidence: 'in 2021', source: 'paper' },
      { path: 'Study Type', value: 'RCT', evidence: 'a page excerpt', source: 'https://x.test', webExcerpt: 'the fetched page said RCT' },
    ])
    expect(msg).toContain('Year')
    expect(msg).toContain('2021')
    expect(msg).toContain('https://x.test')
    expect(msg).toContain('the fetched page said RCT')
  })

  it('says there is nothing to judge when there are no proposals', () => {
    expect(buildJudgeUserMessage([])).toContain('No new or changed proposals')
  })
})

describe('parseJudgeReply', () => {
  it('parses a clean reply', () => {
    const raw = JSON.stringify({
      verdicts: [
        { path: 'Year', verdict: 'accept', feedback: '' },
        { path: 'Study Type', verdict: 'revise', feedback: 'quote does not say RCT' },
      ],
      missed: [{ path: 'Venue', feedback: 'the paper states the venue in the header' }],
    })
    const reply = parseJudgeReply(raw)
    expect(reply.verdicts).toEqual([
      { path: 'Year', verdict: 'accept', feedback: '' },
      { path: 'Study Type', verdict: 'revise', feedback: 'quote does not say RCT' },
    ])
    expect(reply.missed).toEqual([{ path: 'Venue', feedback: 'the paper states the venue in the header' }])
  })

  it('strips a code fence and stray prose', () => {
    const raw = 'Here is my review:\n```json\n' + JSON.stringify({ verdicts: [], missed: [] }) + '\n```'
    expect(parseJudgeReply(raw)).toEqual({ verdicts: [], missed: [] })
  })

  it('drops entries with an invalid verdict rather than throwing', () => {
    const raw = JSON.stringify({
      verdicts: [{ path: 'Year', verdict: 'maybe', feedback: '' }, { path: 'Study Type', verdict: 'reject', feedback: 'no' }],
      missed: [],
    })
    expect(parseJudgeReply(raw).verdicts).toEqual([{ path: 'Study Type', verdict: 'reject', feedback: 'no' }])
  })

  it('never throws on garbage input', () => {
    expect(parseJudgeReply('not json at all')).toEqual({ verdicts: [], missed: [] })
    expect(parseJudgeReply('')).toEqual({ verdicts: [], missed: [] })
  })
})

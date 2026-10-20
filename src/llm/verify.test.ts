import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { checkSubmission, evidenceSupported } from './verify'
import type { SubmitPayload } from './tools'

const schema = resolveSchema([
  { name: 'Study Type', type: 'string' },
  { name: 'Year', type: 'number' },
])

const PAPER_TEXT = 'We conducted a controlled experiment with 24 partici-\npants in 2021.'

describe('evidenceSupported', () => {
  it('matches a quote that spans a page break', () => {
    const text = '[page 1]\nThe study enrolled 120\n\n[page 2]\nparticipants over two years.'
    expect(evidenceSupported('enrolled 120 participants over two years', text)).toBe(true)
  })

  it('accepts an exact quote', () => {
    expect(evidenceSupported('We conducted a controlled experiment with 24 partici-\npants in 2021.', PAPER_TEXT)).toBe(true)
  })

  it('tolerates whitespace/case/hyphenation differences', () => {
    expect(evidenceSupported('we conducted   a controlled experiment with 24 participants', PAPER_TEXT)).toBe(true)
  })

  it('rejects a quote that is not in the paper', () => {
    expect(evidenceSupported('the sample size was 5000 people', PAPER_TEXT)).toBe(false)
  })

  it('rejects an empty quote', () => {
    expect(evidenceSupported('', PAPER_TEXT)).toBe(false)
    expect(evidenceSupported('   ', PAPER_TEXT)).toBe(false)
  })
})

describe('checkSubmission', () => {
  it('accepts a paper-sourced value whose evidence is real', () => {
    const payload: SubmitPayload = {
      fields: [{ path: 'Year', value: 2021, evidence: 'in 2021', source: 'paper' }],
      skipped: [],
    }
    const { answer, failures } = checkSubmission(schema, payload, PAPER_TEXT, new Set())
    expect(failures).toEqual([])
    expect(answer.fields).toEqual([{ path: 'Year', value: 2021, evidence: 'in 2021', confidence: null, source: 'paper' }])
  })

  it('flags a hallucinated quote deterministically', () => {
    const payload: SubmitPayload = {
      fields: [{ path: 'Year', value: 2021, evidence: 'the study ran for a decade', source: 'paper' }],
      skipped: [],
    }
    const { failures } = checkSubmission(schema, payload, PAPER_TEXT, new Set())
    expect(failures).toEqual([{ path: 'Year', reason: 'Evidence quote could not be found in the paper text.' }])
  })

  it('flags a web-sourced value whose URL was never fetched this run', () => {
    const payload: SubmitPayload = {
      fields: [{ path: 'Study Type', value: 'RCT', evidence: 'randomized controlled trial', source: 'https://example.test/paper' }],
      skipped: [],
    }
    const { failures } = checkSubmission(schema, payload, PAPER_TEXT, new Set())
    expect(failures).toHaveLength(1)
    expect(failures[0].path).toBe('Study Type')
    expect(failures[0].reason).toContain('never fetched')
  })

  it('accepts a web-sourced value whose URL was fetched this run, regardless of the paper text', () => {
    const payload: SubmitPayload = {
      fields: [{ path: 'Study Type', value: 'RCT', evidence: 'some excerpt from the web page', source: 'https://example.test/paper' }],
      skipped: [],
    }
    const { failures } = checkSubmission(schema, payload, PAPER_TEXT, new Set(['https://example.test/paper']))
    expect(failures).toEqual([])
  })

  it('still runs schema type-checking (rejected list) alongside evidence checks', () => {
    const payload: SubmitPayload = {
      fields: [{ path: 'Year', value: 'not a year', evidence: 'in 2021', source: 'paper' }],
      skipped: [],
    }
    const { answer, failures } = checkSubmission(schema, payload, PAPER_TEXT, new Set())
    expect(answer.rejected).toHaveLength(1)
    expect(failures).toEqual([]) // nothing accepted, so nothing to evidence-check
  })
})

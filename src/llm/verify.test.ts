import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { checkEvidence, checkSubmission, evidenceSupported, markEvidence } from './verify'
import type { SubmitPayload } from './tools'

const schema = resolveSchema([
  { name: 'Study Type', type: 'string' },
  { name: 'Year', type: 'number' },
])

const PAPER_TEXT = 'We conducted a controlled experiment with 24 partici-\npants in 2021.'

describe('evidenceSupported', () => {
  it('does not match a short quote whose words are only scattered in the paper', () => {
    expect(evidenceSupported('controlled 2021 experiment', PAPER_TEXT)).toBe(false)
    expect(evidenceSupported('controlled experiment', PAPER_TEXT)).toBe(true)
  })

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

// [utest->req~llm-770~1]
describe('checkEvidence', () => {
  const PAGED = '[page 1]\nWe recruited 24 participants.\n\n[page 2]\nThe study ran in 2021 and\n\n[page 3]\nended in 2022.'

  it('verifies a quote on the page the model named', () => {
    expect(checkEvidence('recruited 24 participants', PAGED, 1)).toBe('verified')
  })

  it('verifies a quote without a page wherever it is in the paper', () => {
    expect(checkEvidence('ended in 2022', PAGED)).toBe('verified')
  })

  it('verifies a quote that starts on the named page and runs into the next', () => {
    expect(checkEvidence('The study ran in 2021 and ended in 2022', PAGED, 2)).toBe('verified')
  })

  it('marks a real quote on another page as wrongPage', () => {
    expect(checkEvidence('recruited 24 participants', PAGED, 3)).toBe('wrongPage')
  })

  it('marks a quote missing from the paper as notFound', () => {
    expect(checkEvidence('the sample size was 5000 people', PAGED, 1)).toBe('notFound')
  })

  it('checks nothing without a quote or without paper text', () => {
    expect(checkEvidence('', PAGED, 1)).toBeUndefined()
    expect(checkEvidence('recruited 24 participants', '')).toBeUndefined()
  })

  it('ignores the page when the text has no page markers', () => {
    expect(checkEvidence('in 2021', PAPER_TEXT, 7)).toBe('verified')
  })

  it('markEvidence sets the check only on suggestions with a quote', () => {
    const fields = [
      { path: 'Year', value: 2021, evidence: 'ran in 2021', confidence: null, page: 2 },
      { path: 'Study Type', value: 'x', evidence: 'invented quote here', confidence: null },
      { path: 'Summary', value: 'y', evidence: '', confidence: null },
    ]
    markEvidence(fields, PAGED)
    expect(fields.map((f) => (f as { evidenceCheck?: string }).evidenceCheck)).toEqual(['verified', 'notFound', undefined])
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
    expect(answer.fields).toEqual([
      { path: 'Year', value: 2021, evidence: 'in 2021', confidence: null, source: 'paper', evidenceCheck: 'verified' },
    ])
  })

  it('flags a hallucinated quote deterministically', () => {
    const payload: SubmitPayload = {
      fields: [{ path: 'Year', value: 2021, evidence: 'the study ran for a decade', source: 'paper' }],
      skipped: [],
    }
    const { failures } = checkSubmission(schema, payload, PAPER_TEXT, new Set())
    expect(failures).toEqual([{ path: 'Year', reason: 'Evidence quote could not be found in the paper text.' }])
  })

  // [utest->req~llm-770~1]
  it('marks a wrong page without failing the value', () => {
    const paged = '[page 1]\nWe recruited 24 participants.\n\n[page 2]\nMethods.\n\n[page 3]\nThe study ran in 2021.'
    const payload: SubmitPayload = {
      fields: [{ path: 'Year', value: 2021, evidence: 'ran in 2021', source: 'paper', page: 1 }],
      skipped: [],
    }
    const { answer, failures } = checkSubmission(schema, payload, paged, new Set())
    expect(failures).toEqual([])
    expect(answer.fields[0]).toMatchObject({ page: 1, evidenceCheck: 'wrongPage' })
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

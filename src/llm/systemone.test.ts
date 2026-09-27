import { describe, it, expect } from 'vitest'
import { resolveSchema, type ResolvedDef } from '../model/schema'
import type { FieldTarget } from './fields'
import type { LlmConfig } from './types'
import { API_KEY_SENTINEL } from './types'
import {
  buildSystemOneRequest,
  buildSystemOneVerifyRequest,
  compareWithSystemOne,
  parseSystemOneResponse,
  systemOneEligible,
  SYSTEMONE_VERIFY_ASKED,
} from './systemone'

const schema: ResolvedDef[] = resolveSchema([
  { name: 'Relevant', type: 'boolean' },
  { name: 'Study Type', type: 'string', options: ['RCT', 'Survey'] },
  { name: 'One Option', type: 'string', options: ['Only'] },
  { name: 'Free Text', type: 'string' },
  { name: 'Year', type: 'number' },
])

function target(name: string, value?: unknown): FieldTarget {
  const def = schema.find((d) => d.name === name)!
  return { path: name, def, value: value as never }
}

const cfg: LlmConfig = {
  id: 'cfg1',
  name: 'Test',
  provider: 'openai-compatible',
  baseUrl: 'http://localhost:8080',
  model: 'jev-latest',
  attach: 'text',
  hasKey: true,
}

describe('systemOneEligible', () => {
  it('maps a boolean field to noul', () => {
    expect(systemOneEligible(target('Relevant'))).toBe('noul')
  })

  it('maps a multi-option enum field to choice', () => {
    expect(systemOneEligible(target('Study Type'))).toBe('choice')
  })

  it('rejects a single-option enum (nothing to choose between)', () => {
    expect(systemOneEligible(target('One Option'))).toBeNull()
  })

  it('rejects free text, number and year fields', () => {
    expect(systemOneEligible(target('Free Text'))).toBeNull()
    expect(systemOneEligible(target('Year'))).toBeNull()
  })
})

describe('buildSystemOneRequest', () => {
  const targets = [target('Relevant'), target('Study Type'), target('Free Text')]

  it('returns null when nothing is eligible', () => {
    expect(buildSystemOneRequest(cfg, { title: 'T' }, 'text', [target('Free Text')])).toBeNull()
  })

  it('builds a request with only eligible targets, mapped to safe ascii ids', () => {
    const result = buildSystemOneRequest(cfg, { title: 'T', abstract: 'A' }, 'body text', targets)
    expect(result).not.toBeNull()
    const { request, asked } = result!

    expect(asked).toEqual([
      { id: 'q0', path: 'Relevant', kind: 'noul' },
      { id: 'q1', path: 'Study Type', kind: 'choice', options: ['RCT', 'Survey'] },
    ])

    expect(request.url).toBe('http://localhost:8080/v1/systemone')
    expect(request.headers.Authorization).toBe(`Bearer ${API_KEY_SENTINEL}`)

    const body = JSON.parse(request.body!)
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions)).toEqual(['q0', 'q1'])
    expect(body.questions.q0.type).toBe('noul')
    expect(body.questions.q1).toEqual({
      type: 'choice',
      instructions: 'Study Type',
      criteria: { RCT: 'RCT', Survey: 'Survey' },
    })
    expect(body.state).toContain('T')
    expect(body.state).toContain('A')
    expect(body.state).toContain('body text')
  })

  it('defaults model to jev-latest when cfg.model is empty', () => {
    const result = buildSystemOneRequest({ ...cfg, model: '' }, { title: 'T' }, '', [
      target('Relevant'),
    ])
    const body = JSON.parse(result!.request.body!)
    expect(body.model).toBe('jev-latest')
  })

  it('truncates the state and marks it', () => {
    const longText = 'x'.repeat(100)
    const result = buildSystemOneRequest(
      cfg,
      { title: 'T' },
      longText,
      [target('Relevant')],
      { maxStateChars: 20 },
    )
    const body = JSON.parse(result!.request.body!)
    expect(body.state.length).toBeLessThan(longText.length)
    expect(body.state).toContain('[truncated]')
  })

  it('derives maxStateChars from maxStateTokens when maxStateChars is not given', () => {
    const longText = 'y'.repeat(1000)
    const result = buildSystemOneRequest(
      { ...cfg, maxStateTokens: 10 },
      { title: '' },
      longText,
      [target('Relevant')],
    )
    const body = JSON.parse(result!.request.body!)
    // 10 tokens * 4 chars/token = 40 chars, plus the truncation marker.
    expect(body.state.length).toBeLessThanOrEqual(40 + '\n[truncated]'.length)
    expect(body.state).toContain('[truncated]')
  })
})

describe('parseSystemOneResponse', () => {
  const asked = [
    { id: 'q0', path: 'Relevant', kind: 'noul' as const },
    { id: 'q1', path: 'Study Type', kind: 'choice' as const, options: ['RCT', 'Survey'] },
  ]

  it('parses a clean noul + choice answer', () => {
    const json = {
      model: 'jev-latest',
      answers: {
        q0: { type: 'noul', noul: 0.87 },
        q1: {
          type: 'choice',
          choice: 'RCT',
          probabilities: { RCT: 0.7, Survey: 0.3 },
          confidence: 0.7,
        },
      },
      usage: { input_tokens: 100, output_tokens: 5 },
    }

    const result = parseSystemOneResponse(asked, json)
    expect(result.skipped).toEqual([])
    expect(result.suggestions).toEqual([
      { path: 'Relevant', value: true, evidence: '', confidence: 0.87, source: 'system-one' },
      { path: 'Study Type', value: 'RCT', evidence: '', confidence: 0.7, source: 'system-one' },
    ])
    expect(result.probabilities.Relevant).toEqual({ true: 0.87, false: 0.13 })
    expect(result.probabilities['Study Type']).toEqual({ RCT: 0.7, Survey: 0.3 })
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5 })
  })

  it('flips noul below 0.5 to false, confidence is the max of p/1-p', () => {
    const json = { answers: { q0: { noul: 0.2 }, q1: { choice: 'RCT' } } }
    const result = parseSystemOneResponse(asked, json)
    const relevant = result.suggestions.find((s) => s.path === 'Relevant')!
    expect(relevant.value).toBe(false)
    expect(relevant.confidence).toBeCloseTo(0.8)
  })

  it('falls back to probabilities[choice] when confidence is absent', () => {
    const json = {
      answers: { q1: { choice: 'Survey', probabilities: { RCT: 0.1, Survey: 0.9 } } },
    }
    const result = parseSystemOneResponse([asked[1]], json)
    expect(result.suggestions[0].confidence).toBe(0.9)
  })

  it('skips a choice not among the offered options', () => {
    const json = {
      answers: { q1: { choice: 'Nonsense', probabilities: { RCT: 0.5, Survey: 0.5 } } },
    }
    const result = parseSystemOneResponse([asked[1]], json)
    expect(result.suggestions).toEqual([])
    expect(result.skipped).toEqual([
      { path: 'Study Type', reason: 'choice not among the offered options' },
    ])
  })

  it('rejects a choice outside the schema options even if the reply lists it', () => {
    const json = { answers: { q1: { choice: 'Invented', probabilities: { Invented: 0.9, RCT: 0.1 } } } }
    const result = parseSystemOneResponse([asked[1]], json)
    expect(result.suggestions).toEqual([])
  })

  it('skips answers below the minimum confidence', () => {
    const json = { answers: { q0: { noul: 0.55 } } }
    const result = parseSystemOneResponse([asked[0]], json, { minConfidence: 0.9 })
    expect(result.suggestions).toEqual([])
    expect(result.skipped[0].path).toBe('Relevant')
    expect(result.skipped[0].reason).toMatch(/low confidence/)
  })

  it('is defensive against junk: missing answers, wrong types, non-object json', () => {
    expect(parseSystemOneResponse(asked, null).skipped).toHaveLength(2)
    expect(parseSystemOneResponse(asked, {}).skipped).toHaveLength(2)
    expect(parseSystemOneResponse(asked, { answers: {} }).skipped).toHaveLength(2)

    const junk = { answers: { q0: { noul: 'high' }, q1: { choice: 42 } } }
    const result = parseSystemOneResponse(asked, junk)
    expect(result.suggestions).toEqual([])
    expect(result.skipped.every((s) => s.reason === 'malformed answer')).toBe(true)

    const outOfRange = { answers: { q0: { noul: 1.5 } } }
    expect(parseSystemOneResponse([asked[0]], outOfRange).skipped[0].reason).toBe(
      'malformed answer',
    )

    expect(parseSystemOneResponse(asked, undefined).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    })
  })
})

describe('compareWithSystemOne', () => {
  const asked = [
    { id: 'q0', path: 'Relevant', kind: 'noul' as const },
    { id: 'q1', path: 'Study Type', kind: 'choice' as const, options: ['RCT', 'Survey'] },
  ]

  it('compares a boolean suggestion exactly', () => {
    const s1 = parseSystemOneResponse(asked, { answers: { q0: { noul: 0.9 } } })
    const cmp = compareWithSystemOne([{ path: 'Relevant', value: true, evidence: '', confidence: null }], s1)
    expect(cmp.get('Relevant')).toEqual({ agrees: true, s1Value: true, p: 0.9 })
  })

  it('compares an enum suggestion case-insensitively', () => {
    const s1 = parseSystemOneResponse(asked, {
      answers: { q1: { choice: 'RCT', probabilities: { RCT: 0.8, Survey: 0.2 } } },
    })
    const cmp = compareWithSystemOne(
      [{ path: 'Study Type', value: 'rct', evidence: '', confidence: null }],
      s1,
    )
    expect(cmp.get('Study Type')).toEqual({ agrees: true, s1Value: 'RCT', p: 0.8 })
  })

  it('reports disagreement without dropping the entry', () => {
    const s1 = parseSystemOneResponse(asked, { answers: { q0: { noul: 0.1 } } })
    const cmp = compareWithSystemOne([{ path: 'Relevant', value: true, evidence: '', confidence: null }], s1)
    expect(cmp.get('Relevant')!.agrees).toBe(false)
  })

  it('reports p as System One\'s own confidence in its answer, even when it disagrees', () => {
    // noul=0.1 means System One is 90% confident the field is false, while the
    // suggestion claims true — p must read 0.9 (confidence in `s1Value`), not
    // 0.1 (probability of the suggestion's own claim), so a threshold check
    // reads a confident disagreement as confident.
    const s1 = parseSystemOneResponse(asked, { answers: { q0: { noul: 0.1 } } })
    const cmp = compareWithSystemOne([{ path: 'Relevant', value: true, evidence: '', confidence: null }], s1)
    expect(cmp.get('Relevant')).toEqual({ agrees: false, s1Value: false, p: 0.9 })
  })

  it('omits paths System One has no answer for', () => {
    const s1 = parseSystemOneResponse(asked, { answers: {} })
    const cmp = compareWithSystemOne(
      [{ path: 'Relevant', value: true, evidence: '', confidence: null }],
      s1,
    )
    expect(cmp.size).toBe(0)
  })
})

describe('buildSystemOneVerifyRequest', () => {
  it('builds a minimal one-question request against this target', () => {
    const req = buildSystemOneVerifyRequest(cfg)
    expect(req.url).toBe('http://localhost:8080/v1/systemone')
    expect(req.headers.Authorization).toBe(`Bearer ${API_KEY_SENTINEL}`)
    const body = JSON.parse(req.body!)
    expect(body.model).toBe('jev-latest')
    expect(body.questions.q0.type).toBe('noul')
  })

  it('parses back with SYSTEMONE_VERIFY_ASKED', () => {
    const parsed = parseSystemOneResponse(SYSTEMONE_VERIFY_ASKED, { answers: { q0: { noul: 0.75 } } })
    expect(parsed.probabilities.verify).toEqual({ true: 0.75, false: 0.25 })
  })
})

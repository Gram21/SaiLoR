import { describe, it, expect } from 'vitest'
import { resolveSchema, type ResolvedDef } from '../model/schema'
import type { FieldTarget } from './fields'
import type { LlmConfig } from './types'
import { API_KEY_SENTINEL } from './types'
import { estimateTokens } from './budget'
import { extractError } from './providers'
import {
  mergeSystemOneResults,
  planSystemOneRequests,
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

  it('caps the state at maxStateTokens', () => {
    const result = buildSystemOneRequest(
      { ...cfg, maxStateTokens: 10 },
      { title: 'T' },
      'y'.repeat(1000),
      [target('Relevant')],
    )
    const body = JSON.parse(result!.request.body!)
    expect(estimateTokens(body.state)).toBeLessThanOrEqual(10)
  })
})

const layaCfg: LlmConfig = { ...cfg, model: 'laya', baseUrl: 'http://localhost:8081' }
const CF = 'a'.repeat(32)
const cfCfg: LlmConfig = { ...cfg, model: 'clef-flash', systemOneFlavor: 'cloudflare', accountId: CF }
const pages = (n: number) => Array.from({ length: n }, (_, i) => `[page ${i + 1}]\n${'word '.repeat(2000)}`).join('\n')

describe('planSystemOneRequests', () => {
  const paper = { title: 'Title', abstract: 'An abstract.' }

  it('packs questions under maxQuestions and repeats the state per request', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...target('Relevant'), path: `P${i}` }))
    const plan = planSystemOneRequests(layaCfg, paper, 'body', many)
    // Laya shares its 192-token head budget across a request's questions.
    const sizes = plan.requests.map((r) => r.asked.length)
    expect(sizes.length).toBeGreaterThan(3)
    expect(sizes.every((n) => n <= 16)).toBe(true)
    const ids = plan.requests.flatMap((r) => r.asked.map((a) => a.id))
    expect(new Set(ids).size).toBe(40)
    const jev = planSystemOneRequests({ ...cfg, model: 'jev-latest' }, paper, 'body', many)
    expect(jev.requests.map((r) => r.asked.length)).toEqual([16, 16, 8])
    expect(plan.requests.every((r) => /^q\d+$/.test(r.asked[0].id))).toBe(true)
  })

  it('reports too many options and over-long labels as notHandled', () => {
    const wide = resolveSchema([
      { name: 'Wide', type: 'string', options: Array.from({ length: 30 }, (_, i) => `opt${i}`) },
      { name: 'Long', type: 'string', options: ['A', 'B'].map((x) => x + ' very long label'.repeat(80)) },
    ])
    const t = wide.map((def) => ({ path: def.name, def, value: undefined as never }))
    const plan = planSystemOneRequests(layaCfg, paper, '', t)
    expect(plan.requests).toEqual([])
    expect(plan.notHandled).toEqual([
      { path: 'Wide', reason: 'too many options for laya: use an LLM' },
      { path: 'Long', reason: "labels too long for this model's input window" },
    ])
  })

  it('shortens a long instruction to the field name before giving up', () => {
    const d = resolveSchema([
      { name: 'Short', type: 'string', description: 'long description '.repeat(40), options: Array.from({ length: 10 }, (_, i) => `option-no-${i}`) },
    ])[0]
    const plan = planSystemOneRequests(layaCfg, paper, '', [{ path: 'Short', def: d, value: undefined as never }])
    expect(plan.notHandled).toEqual([])
    expect(JSON.parse(plan.requests[0].request.body!).questions.q0.instructions).toBe('Short')
  })

  it('Laya (512 window) sends title + abstract only, never body', () => {
    const plan = planSystemOneRequests(layaCfg, paper, pages(20), [target('Relevant')])
    expect(plan.state.mode).toBe('abstract-only')
    const state = JSON.parse(plan.requests[0].request.body!).state as string
    expect(state).toContain('Title')
    expect(state).not.toContain('word')
    expect(estimateTokens(state)).toBeLessThanOrEqual(512 - 192 - 1)
  })

  it('Laya without an abstract takes the leading body text that fits', () => {
    const plan = planSystemOneRequests(layaCfg, { title: 'Title' }, pages(20), [target('Relevant')])
    expect(plan.state.mode).toBe('abstract+body')
    expect(plan.state.truncated).toBe(true)
  })

  it('Jev (64k) sends body via page-aware fitting', () => {
    const jev: LlmConfig = { ...cfg, model: 'jev-latest' }
    const plan = planSystemOneRequests(jev, paper, pages(60), [target('Relevant')])
    expect(plan.state.mode).toBe('abstract+body')
    const state = JSON.parse(plan.requests[0].request.body!).state as string
    expect(state).toContain('[page 1]')
    expect(state).toContain('pages omitted')
    expect(estimateTokens(state)).toBeLessThanOrEqual(32_000)
    expect(planSystemOneRequests(jev, paper, 'short body', [target('Relevant')]).state.mode).toBe('full')
  })

  it('is deterministic', () => {
    const a = planSystemOneRequests(layaCfg, paper, pages(3), targetsAll())
    const b = planSystemOneRequests(layaCfg, paper, pages(3), targetsAll())
    expect(a).toEqual(b)
  })

  it('builds the Cloudflare Workers AI request', () => {
    const plan = planSystemOneRequests(cfCfg, paper, 'body', [target('Relevant')])
    const { request } = plan.requests[0]
    expect(request.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${CF}/ai/run/@cf/cloudflare/clef-flash`)
    expect(request.headers.Authorization).toBe(`Bearer ${API_KEY_SENTINEL}`)
    expect(Object.keys(JSON.parse(request.body!)).sort()).toEqual(['model', 'questions', 'state'])
  })

  it('rejects a bad Cloudflare account id with a clear error', () => {
    const plan = planSystemOneRequests({ ...cfCfg, accountId: 'nope' }, paper, '', [target('Relevant')])
    expect(plan.requests).toEqual([])
    expect(plan.error).toMatch(/32/)
    expect(() => buildSystemOneVerifyRequest({ ...cfCfg, accountId: '' })).toThrow()
  })
})

function targetsAll(): FieldTarget[] {
  return [target('Relevant'), target('Study Type')]
}

describe('Cloudflare envelope and merging', () => {
  const asked = [
    { id: 'q0', path: 'Relevant', kind: 'noul' as const },
    { id: 'q1', path: 'Study Type', kind: 'choice' as const, options: ['RCT', 'Survey'] },
  ]
  const envelope = {
    result: {
      model: 'clef-flash',
      answers: {
        q0: { type: 'noul', noul: 0.9, score: 7.3, legend: { '1': 'low' } },
        q1: { type: 'choice', choice: 'RCT', probabilities: { RCT: 0.8, Survey: 0.2 }, score: 1.2 },
      },
      usage: { input_tokens: 120, output_tokens: 8 },
    },
    success: true,
    errors: [],
    messages: [],
  }

  it('unwraps result and tolerates score/legend extras', () => {
    const r = parseSystemOneResponse(asked, envelope)
    expect(r.suggestions.map((s) => s.value)).toEqual([true, 'RCT'])
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 8 })
  })

  it('merges several results', () => {
    const a = parseSystemOneResponse([asked[0]], envelope)
    const b = parseSystemOneResponse([asked[1]], envelope)
    const m = mergeSystemOneResults([a, b])
    expect(m.suggestions).toHaveLength(2)
    expect(m.usage.inputTokens).toBe(240)
  })

  it('extractError reads the Cloudflare error list', () => {
    const body = JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
    expect(extractError('systemone', 403, body)).toContain('Authentication error')
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

import { describe, it, expect, vi } from 'vitest'
import { resolveSchema } from '../model/schema'
import { unansweredFields } from './fields'
import { runAgent, type AgentDeps } from './agent'
import type { LlmConfig, LlmHttpResponse } from './types'
import type { Paper } from '../model/project'

const schema = resolveSchema([
  { name: 'Study Type', type: 'string', options: ['RCT', 'Observational'] },
  { name: 'Year', type: 'number' },
])
const targets = unansweredFields(schema, undefined)

const PAPER_TEXT =
  '[page 1]\nThis study is a randomized controlled trial conducted in 2021 with 24 participants.'

const paper: Paper = {
  id: 'p1',
  title: 'A Great Paper',
  authors: ['A. One'],
  pdf: 'pdfs/p1.pdf',
  annotations: {},
  reviews: {},
  aiUsage: [],
  equal: [],
  alignment: {},
  marks: [],
  reviewMarks: {},
  finished: false,
  reviewsFinished: {},
  extra: {},
}

function config(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'agent',
    name: 'agent',
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    model: 'agent-model',
    attach: 'text',
    hasKey: true,
    ...over,
  }
}

/** A minimal OpenAI-shaped tool-call response, ready to hand to `deps.callLlm`. */
function toolCallResponse(name: string, args: unknown): LlmHttpResponse {
  const body = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
  return { ok: true, status: 200, body: JSON.stringify(body) }
}

function submitResponse(fields: unknown[], skipped: unknown[] = []): LlmHttpResponse {
  return toolCallResponse('submit_annotations', { fields, skipped })
}

function judgeResponse(verdicts: unknown[], missed: unknown[] = []): LlmHttpResponse {
  const body = {
    choices: [{ message: { content: JSON.stringify({ verdicts, missed }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 4 },
  }
  return { ok: true, status: 200, body: JSON.stringify(body) }
}

/** Runs `deps.callLlm` against a fixed, ordered script of responses — the
 *  agent and judge share one call sequence, in the order runAgent makes them. */
function scriptedDeps(script: LlmHttpResponse[]): AgentDeps {
  const queue = [...script]
  return {
    callLlm: vi.fn(async () => {
      const next = queue.shift()
      if (!next) throw new Error('test bug: callLlm invoked past the end of the script')
      return next
    }),
    fetchWeb: vi.fn(),
  }
}

const goodFields = [
  { path: 'Study Type', value: 'RCT', evidence: 'is a randomized controlled trial', source: 'paper' },
  { path: 'Year', value: 2021, evidence: 'conducted in 2021', source: 'paper' },
]

describe('runAgent', () => {
  it('(a) accepts everything in one round when the judge accepts all', async () => {
    const deps = scriptedDeps([
      submitResponse(goodFields),
      judgeResponse([
        { path: 'Study Type', verdict: 'accept', feedback: '' },
        { path: 'Year', verdict: 'accept', feedback: '' },
      ]),
    ])
    const result = await runAgent(
      { config: config(), judgeConfig: config({ id: 'judge' }), schema, targets, paper, paperText: PAPER_TEXT, delivery: 'text' },
      deps,
    )
    expect(result.rounds).toBe(1)
    expect(result.answer.fields).toHaveLength(2)
    expect(result.answer.fields.every((f) => f.judge?.verdict === 'accept')).toBe(true)
    expect(result.answer.rejected).toEqual([])
    expect(result.usage.calls).toBe(2)
  })

  it('(b) revises a judge-flagged field and is accepted in round 2', async () => {
    const revisedFields = [
      { path: 'Study Type', value: 'RCT', evidence: 'a randomized controlled trial conducted', source: 'paper' },
      { path: 'Year', value: 2021, evidence: 'conducted in 2021', source: 'paper' },
    ]
    const deps = scriptedDeps([
      submitResponse(goodFields),
      judgeResponse([
        { path: 'Study Type', verdict: 'revise', feedback: 'quote is too short to be sure' },
        { path: 'Year', verdict: 'accept', feedback: '' },
      ]),
      submitResponse(revisedFields),
      judgeResponse([{ path: 'Study Type', verdict: 'accept', feedback: '' }]),
    ])
    const result = await runAgent(
      { config: config(), judgeConfig: config({ id: 'judge' }), schema, targets, paper, paperText: PAPER_TEXT, delivery: 'text' },
      deps,
    )
    expect(result.rounds).toBe(2)
    const studyType = result.answer.fields.find((f) => f.path === 'Study Type')
    expect(studyType?.judge?.verdict).toBe('accept')
    expect(studyType?.evidence).toBe('a randomized controlled trial conducted')
  })

  it('(c) stops at maxRounds and keeps the judge feedback on an unaccepted field', async () => {
    const deps = scriptedDeps([
      submitResponse(goodFields),
      judgeResponse([
        { path: 'Study Type', verdict: 'revise', feedback: 'evidence is ambiguous' },
        { path: 'Year', verdict: 'accept', feedback: '' },
      ]),
    ])
    const result = await runAgent(
      {
        config: config(),
        judgeConfig: config({ id: 'judge' }),
        schema,
        targets,
        paper,
        paperText: PAPER_TEXT,
        delivery: 'text',
        maxRounds: 1,
      },
      deps,
    )
    expect(result.rounds).toBe(1)
    const studyType = result.answer.fields.find((f) => f.path === 'Study Type')
    expect(studyType?.judge).toEqual({ verdict: 'revise', feedback: 'evidence is ambiguous' })
  })

  it('(d) catches a hallucinated quote deterministically, without the judge accepting it', async () => {
    const hallucinated = [
      { path: 'Study Type', value: 'RCT', evidence: 'a completely fabricated quote never in this paper', source: 'paper' },
    ]
    const deps = scriptedDeps([submitResponse(hallucinated), judgeResponse([])])
    const result = await runAgent(
      {
        config: config(),
        judgeConfig: config({ id: 'judge' }),
        schema,
        targets,
        paper,
        paperText: PAPER_TEXT,
        delivery: 'text',
        maxRounds: 1,
      },
      deps,
    )
    expect(result.answer.fields).toEqual([])
    expect(result.answer.rejected).toEqual([
      { path: 'Study Type', raw: 'RCT', reason: 'Evidence quote could not be found in the paper text.' },
    ])
  })

  it('(e) aborts promptly via the passed signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = scriptedDeps([submitResponse(goodFields)])
    await expect(
      runAgent(
        { config: config(), schema, targets, paper, paperText: PAPER_TEXT, delivery: 'text', signal: controller.signal },
        deps,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('judges with the agent target when no separate judge is configured', async () => {
    const deps = scriptedDeps([
      submitResponse(goodFields),
      judgeResponse(goodFields.map((f) => ({ path: (f as { path: string }).path, verdict: 'accept', feedback: '' }))),
    ])
    const result = await runAgent(
      { config: config(), schema, targets, paper, paperText: PAPER_TEXT, delivery: 'text' },
      deps,
    )
    expect(result.rounds).toBe(1)
    expect(result.answer.fields).toHaveLength(2)
  })
})

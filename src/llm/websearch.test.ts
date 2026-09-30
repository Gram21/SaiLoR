import { describe, it, expect, vi } from 'vitest'
import { resolveSchema } from '../model/schema'
import { unansweredFields } from './fields'
import { buildChatRequest, parseChatResponse, type ToolDef } from './chat'
import { PROVIDERS, PROVIDER_LIST } from './providers'
import { runAgent, type AgentDeps } from './agent'
import { checkSubmission, normalizeUrl } from './verify'
import { buildAgentSystemPrompt } from './prompt'
import { buildJudgeUserMessage } from './judge'
import { estimateRun, WEB_SEARCH_NOTE } from './cost'
import type { LlmConfig, LlmHttpResponse, Provider } from './types'
import type { Paper } from '../model/project'

const schema = resolveSchema([
  { name: 'Study Type', type: 'string', options: ['RCT', 'Observational'] },
  { name: 'Year', type: 'number' },
])
const targets = unansweredFields(schema, undefined)
const PAPER_TEXT = '[page 1]\nThis study is a randomized controlled trial conducted in 2021.'
const TOOLS: ToolDef[] = [{ name: 't', description: 'd', parameters: { type: 'object' } }]

function cfg(provider: Provider): LlmConfig {
  return { id: 'c', name: 'c', provider, baseUrl: PROVIDERS[provider].defaultBaseUrl, model: 'm', attach: 'text', hasKey: true }
}
const bodyOf = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>
const build = (p: Provider, webSearch?: boolean) =>
  bodyOf(buildChatRequest(cfg(p), 's', [{ role: 'user', content: 'go' }], TOOLS, { webSearch }))

describe('web search request building', () => {
  it('only anthropic and openrouter support it', () => {
    expect(PROVIDER_LIST.filter((p) => p.supportsWebSearch).map((p) => p.id)).toEqual(['anthropic', 'openrouter'])
  })

  it('anthropic adds the server tool next to function tools, capped', () => {
    expect(build('anthropic', true).tools).toEqual([
      { name: 't', description: 'd', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ])
  })

  it('openrouter adds the web plugin', () => {
    expect(build('openrouter', true).plugins).toEqual([{ id: 'web', max_results: 5 }])
  })

  it.each(PROVIDER_LIST.map((p) => p.id))('%s: nothing added when off', (p) => {
    const b = build(p)
    expect(JSON.stringify(b)).not.toContain('web_search')
    expect(b.plugins).toBeUndefined()
  })

  it.each(['openai', 'google', 'groq', 'mistral', 'deepseek', 'xai', 'openai-compatible'] as Provider[])(
    '%s: flag ignored (unsupported)',
    (p) => {
      expect(build(p, true)).toEqual(build(p))
    },
  )
})

const anthropicSearchTurn = {
  stop_reason: 'end_turn',
  content: [
    { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'q' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv1',
      content: [{ type: 'web_search_result', url: 'https://a.test/x', title: 'A', encrypted_content: 'ENC' }],
    },
    {
      type: 'text',
      text: 'done',
      citations: [{ type: 'web_search_result_location', url: 'https://b.test/y', title: 'B', encrypted_index: 'I' }],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 2, server_tool_use: { web_search_requests: 1 } },
}

describe('web search response parsing', () => {
  it('anthropic: counts searches, collects result + citation urls, keeps raw verbatim', () => {
    const r = parseChatResponse('anthropic', anthropicSearchTurn)
    expect(r.webSearches).toBe(1)
    expect(r.citations).toEqual([
      { url: 'https://a.test/x', title: 'A' },
      { url: 'https://b.test/y', title: 'B' },
    ])
    expect(r.paused).toBe(false)
    expect(r.raw).toBe(anthropicSearchTurn.content)
  })

  it('anthropic: pause_turn is flagged; falls back to counting blocks', () => {
    const r = parseChatResponse('anthropic', { ...anthropicSearchTurn, stop_reason: 'pause_turn', usage: {} })
    expect(r.paused).toBe(true)
    expect(r.webSearches).toBe(1)
  })

  it('openrouter: url_citation annotations', () => {
    const r = parseChatResponse('openrouter', {
      choices: [
        {
          message: {
            content: 'x',
            annotations: [{ type: 'url_citation', url_citation: { url: 'https://c.test', title: 'C' } }],
          },
        },
      ],
    })
    expect(r.citations).toEqual([{ url: 'https://c.test', title: 'C' }])
    expect(r.webSearches).toBe(1)
  })

  it('plain responses report none', () => {
    const r = parseChatResponse('openai', { choices: [{ message: { content: 'x' } }] })
    expect(r).toMatchObject({ webSearches: 0, citations: [], paused: false })
  })

  it('anthropic replay sends server-tool blocks (with encrypted content) unchanged', () => {
    const parsed = parseChatResponse('anthropic', anthropicSearchTurn)
    const b = bodyOf(
      buildChatRequest(cfg('anthropic'), 's', [
        { role: 'user', content: 'go' },
        { role: 'assistant', raw: parsed.raw },
      ], TOOLS),
    )
    expect(b.messages[1]).toEqual({ role: 'assistant', content: anthropicSearchTurn.content })
  })
})

describe('verification of search-sourced values', () => {
  const payload = (source: string) => ({
    fields: [{ path: 'Year', value: 2021, evidence: 'whatever the snippet said', source }],
    skipped: [],
  })

  it('normalizes fragment and trailing slash', () => {
    expect(normalizeUrl(' https://a.test/x/#frag')).toBe('https://a.test/x')
  })

  it('accepts a search-result source and flags it unverified', () => {
    const { answer, failures } = checkSubmission(schema, payload('https://a.test/x/'), PAPER_TEXT, new Set(), new Set(['https://a.test/x#r']))
    expect(failures).toEqual([])
    expect(answer.fields[0].webUnverified).toBe(true)
  })

  it('fetched source is not flagged', () => {
    const { answer } = checkSubmission(schema, payload('https://a.test/x'), PAPER_TEXT, new Set(['https://a.test/x']), new Set(['https://a.test/x']))
    expect(answer.fields[0].webUnverified).toBeUndefined()
  })

  it('unknown source url fails deterministically', () => {
    const { failures } = checkSubmission(schema, payload('https://evil.test'), PAPER_TEXT, new Set(), new Set(['https://a.test/x']))
    expect(failures[0].reason).toContain('web search')
  })

  it('judge is told the quote is unchecked', () => {
    const msg = buildJudgeUserMessage([{ path: 'Year', value: 2021, evidence: 'e', source: 'https://a.test', webUnverified: true }])
    expect(msg).toContain('could NOT be checked')
    expect(buildJudgeUserMessage([{ path: 'Year', value: 2021, evidence: 'e' }])).not.toContain('NOT be checked')
  })
})

describe('prompt and cost', () => {
  it('prompt is byte-identical when off and gains one rule when on', () => {
    const off = buildAgentSystemPrompt(schema, targets, 'text')
    expect(buildAgentSystemPrompt(schema, targets, 'text', undefined, false)).toBe(off)
    const on = buildAgentSystemPrompt(schema, targets, 'text', undefined, true)
    expect(on.startsWith(off)).toBe(true)
    expect(on.slice(off.length)).toContain('exact result URL')
  })

  it('estimateRun raises agent estimates only when webSearch is on', () => {
    const base = { papers: [{ pages: 10 }], fieldsPerPaper: 5, mode: 'agent' as const, delivery: 'text' as const }
    const off = estimateRun(base)
    const on = estimateRun({ ...base, webSearch: true })
    expect(on.high.inputTokens).toBeGreaterThan(off.high.inputTokens)
    expect(on.requests.high).toBeGreaterThan(off.requests.high)
    expect(on.judge).toEqual(off.judge)
    expect(estimateRun({ ...base, webSearch: false })).toEqual(off)
    expect(WEB_SEARCH_NOTE).toMatch(/billed per search/)
  })
})

describe('runAgent with web search', () => {
  const paper = { id: 'p', title: 'T', authors: ['A'] } as unknown as Paper
  const ok = (body: unknown): LlmHttpResponse => ({ ok: true, status: 200, body: JSON.stringify(body) })
  const paused = ok({ stop_reason: 'pause_turn', content: anthropicSearchTurn.content.slice(0, 2), usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } } })
  const submit = (source: string) =>
    ok({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'submit_annotations',
          input: { fields: [{ path: 'Year', value: 2021, evidence: 'snippet', source }], skipped: [] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  const judge = ok({
    content: [{ type: 'text', text: JSON.stringify({ verdicts: [{ path: 'Year', verdict: 'accept', feedback: '' }], missed: [] }) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  it('continues after pause_turn, records searches, flags the value unverified', async () => {
    const script = [paused, submit('https://a.test/x'), judge]
    const callLlm = vi.fn(async (_req: unknown) => script.shift()!)
    const deps: AgentDeps = { callLlm, fetchWeb: vi.fn() }
    const events: string[] = []
    const res = await runAgent(
      { config: cfg('anthropic'), schema, targets, paper, paperText: PAPER_TEXT, delivery: 'text', webSearch: true, onEvent: (e) => events.push(e.message) },
      deps,
    )
    // Second request replays the paused turn as the last assistant message, no extra user text.
    const second = JSON.parse((callLlm.mock.calls[1][0] as { body: string }).body)
    expect(second.messages.at(-1)).toEqual({ role: 'assistant', content: anthropicSearchTurn.content.slice(0, 2) })
    expect(JSON.stringify(second.tools)).toContain('web_search_20250305')
    expect(res.usage.webSearches).toBe(1)
    expect(events).toContain('Searching the web…')
    expect(res.answer.fields[0].webUnverified).toBe(true)
  })

  it('rejects a source that no search returned', async () => {
    const script = [paused, submit('https://nope.test'), judge, submit('https://nope.test'), judge, submit('https://nope.test')]
    const deps: AgentDeps = { callLlm: vi.fn(async () => script.shift()!), fetchWeb: vi.fn() }
    const res = await runAgent(
      { config: cfg('anthropic'), schema, targets, paper, paperText: PAPER_TEXT, delivery: 'text', webSearch: true, maxRounds: 1 },
      deps,
    )
    expect(res.answer.fields).toEqual([])
    expect(res.answer.rejected[0].reason).toContain('web search')
  })
})

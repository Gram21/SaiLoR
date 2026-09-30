import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, LlmHttpRequest, LlmHttpResponse } from '../llm/types'

let configs: LlmConfig[] = []
let calls: LlmHttpRequest[] = []
/** Per-title canned reply; a function lets a test hold a call open. */
let replies: Record<string, () => Promise<LlmHttpResponse> | LlmHttpResponse> = {}

vi.mock('../model/pdfText', () => ({
  extractPdfText: vi.fn(async () => ({ text: 'excerpt of the pdf', pages: 1, empty: false })),
}))

const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: 'blob://paper' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => configs,
  saveLlmConfig: async () => configs,
  deleteLlmConfig: async () => [],
  callLlm: async (request: LlmHttpRequest) => {
    calls.push(request)
    const body = request.body ?? ''
    const key = Object.keys(replies).find((k) => body.includes(`Title: ${k}`))
    if (!key) throw new Error('no reply configured')
    return replies[key]()
  },
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))
vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }))

const { useStore, aiMarkKey, fieldPath } = await import('./store')
const { useAiStore } = await import('./aiStore')
const { useAiScreeningStore, screeningCandidates, defaultChecked } = await import('./aiScreeningStore')

const CHAT: LlmConfig = { id: 'c1', name: 'Chat', provider: 'anthropic', baseUrl: '', model: 'claude-x', attach: 'text', hasKey: true }
const S1: LlmConfig = { id: 's1', name: 'S1', provider: 'systemone', baseUrl: 'https://s1.example', model: 'jev', attach: 'text', hasKey: true }

const chatReply = (obj: unknown): LlmHttpResponse => ({
  ok: true,
  status: 200,
  body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 5, output_tokens: 3 } }),
})

function project(opts: { reviewers?: number; aiSeat?: boolean } = {}) {
  return JSON.stringify({
    version: 1,
    config: {
      screening: { reasons: ['Wrong topic', 'Duplicate'] },
      ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
      ...(opts.aiSeat ? { aiSeat: true } : {}),
    },
    protocol: { notes: 'Include only empirical studies' },
    papers: [
      { id: 'p1', title: 'Alpha', authors: [], pdf: '', abstract: 'abs a', annotations: {} },
      { id: 'p2', title: 'Beta', authors: [], pdf: '', abstract: 'abs b', annotations: {} },
      { id: 'p3', title: 'Gamma', authors: [], pdf: '', abstract: 'abs c', annotations: {} },
      { id: 'p4', title: 'Delta', authors: [], pdf: '', annotations: {} },
    ],
  })
}

const st = () => useStore.getState()
const ai = () => useAiScreeningStore.getState()

async function openAll(text = project()) {
  st().loadFromText(text, null, 'test.json')
  st().selectPaper('p1')
  await ai().openDialog()
  ai().setAllPapers(true)
}

beforeEach(() => {
  configs = [CHAT, S1]
  calls = []
  replies = {
    Alpha: () => chatReply({ decision: 'Include', reason: null, justification: 'fits', evidence: 'abs a', confidence: 0.95 }),
    Beta: () => chatReply({ decision: 'Exclude', reason: 'Wrong topic', justification: 'off topic', evidence: 'abs b', confidence: 0.99 }),
    Gamma: () => chatReply({ decision: 'Include', reason: null, justification: 'maybe', evidence: '', confidence: 0.5 }),
  }
  ai().closeDialog()
  useAiStore.setState({ configs, selectedId: 'c1' })
  useAiScreeningStore.setState({ engine: 'prompt', selectedId: 'c1', threshold: 0.8, concurrency: 2 })
})

describe('defaultChecked (conservative ticks)', () => {
  const p = (decision: 'Include' | 'Exclude', confidence: number | null) => ({
    decision,
    reason: decision === 'Exclude' ? 'Wrong topic' : null,
    justification: '',
    evidence: '',
    confidence,
  })
  it('never ticks Exclude, ticks Include only at or above the threshold', () => {
    expect(defaultChecked(p('Exclude', 1), 0.8)).toBe(false)
    expect(defaultChecked(p('Include', 0.8), 0.8)).toBe(true)
    expect(defaultChecked(p('Include', 0.79), 0.8)).toBe(false)
    expect(defaultChecked(p('Include', null), 0.8)).toBe(false)
  })
})

describe('candidates', () => {
  it('are titled papers undecided in the target seat', async () => {
    await openAll()
    st().setScreeningDecision('Include')
    expect(screeningCandidates(st().project!, null).map((c) => c.id)).toEqual(['p2', 'p3', 'p4'])
  })
})

describe('run', () => {
  it('proposes per paper, skips a paper without abstract or PDF, and ticks conservatively', async () => {
    await openAll()
    await ai().run()
    const s = ai()
    expect(s.phase).toBe('review')
    expect(s.rows.map((r) => [r.paperId, r.checked])).toEqual([
      ['p1', true],
      ['p2', false],
      ['p3', false],
    ])
    expect(s.skipped).toEqual([{ paperId: 'p4', paperTitle: 'Delta', message: 'no abstract' }])
    expect(s.usage).toEqual({ calls: 3, inputTokens: 15, outputTokens: 9 })
    // Protocol reaches the system prompt, paper text only the user message.
    const sent = JSON.parse(calls[0].body!)
    expect(sent.system).toContain('Include only empirical studies')
    expect(sent.system).not.toContain('abs a')
  })

  it('keeps going past a failing paper and lists the error', async () => {
    replies.Beta = () => ({ ok: false, status: 400, body: '{"error":{"message":"bad"}}' })
    replies.Gamma = () => chatReply({ decision: 'Exclude', reason: 'Nope' })
    await openAll()
    await ai().run()
    expect(ai().rows.map((r) => r.paperId)).toEqual(['p1'])
    expect(ai().errors.map((e) => e.paperId).sort()).toEqual(['p2', 'p3'])
  })

  it('current-paper scope sends one request', async () => {
    st().loadFromText(project(), null, 'test.json')
    st().selectPaper('p2')
    await ai().openDialog()
    await ai().run()
    expect(calls).toHaveLength(1)
    expect(ai().rows.map((r) => r.paperId)).toEqual(['p2'])
  })

  it('classify uses the System One model and asks decision + reason', async () => {
    replies.Alpha = () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ answers: { q0: { choice: 'Include', confidence: 0.9 } }, usage: { input_tokens: 4, output_tokens: 1 } }),
    })
    st().loadFromText(project(), null, 'test.json')
    st().selectPaper('p1')
    await ai().openDialog()
    ai().setEngine('classify')
    await ai().run()
    expect(calls[0].url).toBe('https://s1.example/v1/systemone')
    expect(ai().rows[0]).toMatchObject({ engine: 'classify', checked: true })
  })
})

describe('apply', () => {
  it('writes ticked rows in one undo step, marks them AI, records disclosure', async () => {
    await openAll()
    await ai().run()
    ai().toggleRow('p2') // tick the Exclude
    ai().apply()
    const papers = st().project!.papers
    expect(papers[0].annotations.Decision[0].value).toBe('Include')
    expect(papers[1].annotations.Decision[0].value).toBe('Exclude')
    expect(papers[1].annotations.Reason[0].value).toBe('Wrong topic')
    expect(papers[2].annotations.Decision[0].value).toBeNull()
    expect(papers[0].aiUsage).toMatchObject([{ provider: 'anthropic', model: 'claude-x', mode: 'screening' }])
    expect(st().aiMarks[aiMarkKey('p1', fieldPath([], 'Decision', 0))]).toBe(true)
    expect(st().aiMarks[aiMarkKey('p2', fieldPath([], 'Reason', 0))]).toBe(true)
    expect(st().currentPaperId).toBe('p1')
    expect(ai().applied).toEqual({ written: 2, skipped: 0 })

    st().undo()
    expect(st().project!.papers[0].annotations.Decision[0].value).toBeNull()
    expect(st().project!.papers[1].annotations.Decision[0].value).toBeNull()
  })

  it('never overwrites a decision the human made meanwhile', async () => {
    await openAll()
    await ai().run()
    st().selectPaper('p1')
    st().setScreeningDecision('Exclude', 'Duplicate')
    ai().apply()
    const p1 = st().project!.papers[0]
    expect(p1.annotations.Decision[0].value).toBe('Exclude')
    expect(p1.annotations.Reason[0].value).toBe('Duplicate')
    expect(p1.aiUsage).toEqual([])
    expect(ai().applied).toEqual({ written: 0, skipped: 1 })
  })

  it('leaves no undo entry when nothing was written', async () => {
    await openAll()
    await ai().run()
    ai().setAllChecked(false)
    const before = st().past.length
    ai().apply()
    expect(st().past.length).toBe(before)
  })
})

describe('seat routing', () => {
  it('targets the AI seat when the project has one, whichever seat is selected', async () => {
    st().loadFromText(project({ reviewers: 2, aiSeat: true }), null, 'test.json')
    st().selectPaper('p1')
    st().selectReviewer('1')
    await ai().openDialog()
    expect(ai().targetSeat).toBe('2')
    await ai().run()
    ai().apply()
    const p1 = st().project!.papers[0]
    expect(p1.reviews['2'].Decision[0].value).toBe('Include')
    expect(p1.annotations.Decision[0].value).toBeNull()
    expect(p1.aiUsage[0].reviewer).toBe('2')
  })

  it('targets the selected human seat without an AI seat, and refuses without a pick', async () => {
    st().loadFromText(project({ reviewers: 2 }), null, 'test.json')
    st().selectPaper('p1')
    await ai().openDialog()
    expect(ai().open).toBe(false)
    st().selectReviewer('1')
    await ai().openDialog()
    expect(ai().targetSeat).toBe('1')
  })
})

describe('lifecycle', () => {
  it('a run in flight when the project closes is discarded', async () => {
    let release!: () => void
    replies.Alpha = () =>
      new Promise((resolve) => {
        release = () => resolve(chatReply({ decision: 'Include', confidence: 1 }))
      })
    st().loadFromText(project(), null, 'test.json')
    st().selectPaper('p1')
    await ai().openDialog()
    const running = ai().run()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    st().closeProject()
    expect(ai().open).toBe(false)
    release()
    await running
    expect(ai().rows).toEqual([])
    expect(ai().phase).toBe('setup')
  })
})

describe('applyAiScreeningBatch guards', () => {
  const item = (reviewer: string | null, decision = 'Include', reason: string | null = null) => ({
    paperId: 'p1',
    reviewer,
    decision,
    reason,
    usage: { provider: 'anthropic', model: 'm', mode: 'screening' as const },
  })

  it('refuses Consolidation, a missing seat, an unknown reason and a seat that is not selected', () => {
    st().loadFromText(project({ reviewers: 2 }), null, 'test.json')
    expect(st().applyAiScreeningBatch([item('1')]).written).toBe(0) // nobody picked
    st().selectReviewer('consolidation')
    expect(st().applyAiScreeningBatch([item(null)]).written).toBe(0)
    st().selectReviewer('1')
    expect(st().applyAiScreeningBatch([item('1', 'Exclude', 'Made up')]).written).toBe(0)
    expect(st().applyAiScreeningBatch([item('2')]).written).toBe(0)
    expect(st().dirty).toBe(false)
    expect(st().applyAiScreeningBatch([item('1')]).written).toBe(1)
  })
})

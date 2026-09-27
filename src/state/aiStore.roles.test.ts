import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig } from '../llm/types'

if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
    configurable: true,
  })
}

/**
 * Goal A: role assignment (annotator/judge/cross-check) is remembered per
 * project, falling back to the last global choice when this project has
 * never set one — and a System One model never shows up where a chat model
 * belongs, or vice versa.
 */

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
  listLlmConfigs: async (): Promise<LlmConfig[]> => [],
  saveLlmConfig: async (config: LlmConfig) => [{ ...config, hasKey: true }],
  deleteLlmConfig: async () => [],
  callLlm: vi.fn(),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useAiStore } = await import('./aiStore')

function projectJson(title: string, paperId: string) {
  return JSON.stringify({
    version: 1,
    title,
    config: { schema: [{ name: 'Summary', type: 'string' }] },
    papers: [{ id: paperId, title: 'Paper', authors: [], pdf: `${paperId}.pdf`, annotations: {} }],
  })
}

function chatCfg(id: string): LlmConfig {
  return { id, name: id, provider: 'anthropic', baseUrl: '', model: 'claude-x', attach: 'text', hasKey: true }
}

function s1Cfg(id: string): LlmConfig {
  return { id, name: id, provider: 'systemone', baseUrl: '', model: 'jev-latest', attach: 'text', hasKey: true }
}

const st = () => useStore.getState()
const ai = () => useAiStore.getState()

beforeEach(() => {
  localStorage.clear()
  useAiStore.setState({
    configs: [],
    selectedId: null,
    judgeSelectedId: null,
    crossCheckId: null,
    mode: 'prompt',
  })
})

describe('role persistence: per project, falling back to the last global choice', () => {
  it('writes both the global key and a per-project record when a role is assigned', () => {
    st().loadFromText(projectJson('Proj A', 'p1'), null, 'a.json')
    st().selectPaper('p1')
    ai().selectConfig('cfgA')
    ai().selectJudge('judgeA')
    ai().selectCrossCheck('s1A')

    expect(localStorage.getItem('slr.llm.selected')).toBe('cfgA')
    expect(localStorage.getItem('slr.llm.judge')).toBe('judgeA')
    expect(localStorage.getItem('slr.llm.crosscheck')).toBe('s1A')
    const stored = JSON.parse(localStorage.getItem('slr.llm.roles.Proj A')!)
    expect(stored).toEqual({ annotatorId: 'cfgA', judgeId: 'judgeA', crossCheckId: 's1A' })
  })

  it('opening a different project prefers its own remembered role over the other project\'s', async () => {
    const cfgA = chatCfg('cfgA')
    const cfgB = chatCfg('cfgB')
    mockPlatform.listLlmConfigs = async () => [cfgA, cfgB]

    st().loadFromText(projectJson('Proj A', 'p1'), null, 'a.json')
    st().selectPaper('p1')
    await ai().openDialog()
    ai().selectConfig('cfgA')

    st().loadFromText(projectJson('Proj B', 'p2'), null, 'b.json')
    st().selectPaper('p2')
    await ai().openDialog()
    ai().selectConfig('cfgB')
    expect(ai().selectedId).toBe('cfgB')

    // Reopening project A must not have been clobbered by project B's choice.
    st().loadFromText(projectJson('Proj A', 'p1'), null, 'a.json')
    st().selectPaper('p1')
    await ai().openDialog()
    expect(ai().selectedId).toBe('cfgA')
  })

  it('falls back to the last global choice for a project that never picked one itself', async () => {
    const cfgA = chatCfg('cfgA')
    mockPlatform.listLlmConfigs = async () => [cfgA]

    st().loadFromText(projectJson('Proj A', 'p1'), null, 'a.json')
    st().selectPaper('p1')
    ai().selectConfig('cfgA') // sets the global fallback too

    // A brand-new project, never opened before — its own per-project record
    // is empty, so the global fallback (already in `selectedId`/localStorage)
    // is what `refreshConfigs`/init already carries forward.
    st().loadFromText(projectJson('Fresh Project', 'p9'), null, 'fresh.json')
    st().selectPaper('p9')
    await ai().openDialog()
    expect(ai().selectedId).toBe('cfgA')
  })

  it('ignores a per-project role whose model no longer exists among configured models', async () => {
    const cfgA = chatCfg('cfgA')
    mockPlatform.listLlmConfigs = async () => [cfgA]
    st().loadFromText(projectJson('Proj A', 'p1'), null, 'a.json')
    st().selectPaper('p1')
    await ai().openDialog()
    ai().selectConfig('deleted-model')

    mockPlatform.listLlmConfigs = async () => [cfgA] // the "deleted-model" id is gone
    await ai().openDialog()
    expect(ai().selectedId).not.toBe('deleted-model')
  })
})

describe('System One / chat model separation', () => {
  it('switching to classify mode drops a chat-model annotator selection', () => {
    const chat = chatCfg('chat1')
    useAiStore.setState({ configs: [chat], selectedId: chat.id, mode: 'prompt' })
    ai().setMode('classify')
    expect(ai().selectedId).not.toBe(chat.id)
  })

  it('switching away from classify mode drops a System One annotator selection', () => {
    const s1 = s1Cfg('s1-1')
    const chat = chatCfg('chat1')
    useAiStore.setState({ configs: [s1, chat], selectedId: s1.id, mode: 'classify' })
    ai().setMode('prompt')
    expect(ai().selectedId).toBe(chat.id)
  })

  it('drops a stale cross-check selection on refresh, same as judge', async () => {
    mockPlatform.listLlmConfigs = async () => []
    useAiStore.setState({ crossCheckId: 'gone' })
    await ai().refreshConfigs()
    expect(ai().crossCheckId).toBeNull()
  })
})

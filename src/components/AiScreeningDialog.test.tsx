import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig } from '../llm/types'

const CFG: LlmConfig = { id: 'c1', name: 'Test target', provider: 'anthropic', baseUrl: '', model: 'claude-x', attach: 'text', hasKey: true }

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
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [CFG],
  saveLlmConfig: async () => [CFG],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({
    ok: true,
    status: 200,
    body: JSON.stringify({
      content: [{ type: 'text', text: '{"decision":"Exclude","reason":"Wrong topic","justification":"off","evidence":"q","confidence":0.99}' }],
    }),
  }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('../state/store')
const { useAiStore } = await import('../state/aiStore')
const { useAiScreeningStore } = await import('../state/aiScreeningStore')
const { AiScreeningDialog } = await import('./AiScreeningDialog')

const PROJECT = JSON.stringify({
  version: 1,
  config: { screening: { reasons: ['Wrong topic'] } },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: '', abstract: 'abs', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: '', abstract: 'abs', annotations: {} },
  ],
})

beforeEach(async () => {
  useAiScreeningStore.getState().closeDialog()
  useStore.getState().loadFromText(PROJECT, null, 'test.json')
  useStore.getState().selectPaper('p1')
  useAiStore.setState({ configs: [CFG], selectedId: 'c1' })
  useAiScreeningStore.setState({ engine: 'prompt', selectedId: 'c1' })
  await useAiScreeningStore.getState().openDialog()
})

describe('AiScreeningDialog', () => {
  it('shows the current-paper scope and warns before enabling all papers', async () => {
    render(<AiScreeningDialog />)
    expect(screen.getByText('Paper One')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Screen all undecided papers'))
    expect(screen.getByText(/one request per paper/)).toBeInTheDocument()
    expect(useAiScreeningStore.getState().allPapers).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Screen all 2 papers' }))
    expect(useAiScreeningStore.getState().allPapers).toBe(true)
  })

  it('runs, leaves an Exclude proposal unticked, and applies it once ticked', async () => {
    render(<AiScreeningDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    const box = await screen.findByRole('checkbox', { name: /Apply Exclude to Paper One/ })
    expect(box).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Apply 0' })).toBeDisabled()
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1' }))
    expect(screen.getByText(/Recorded 1 decision/)).toBeInTheDocument()
    expect(useStore.getState().project!.papers[0].annotations.Reason[0].value).toBe('Wrong topic')
  })

  it('offers to set up a model when none suits the engine', async () => {
    useAiStore.setState({ configs: [] })
    mockPlatform.listLlmConfigs = async () => []
    await useAiScreeningStore.getState().openDialog()
    render(<AiScreeningDialog />)
    expect(screen.getByRole('button', { name: 'Set up a model…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
  })
})

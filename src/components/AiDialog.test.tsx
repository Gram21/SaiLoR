import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig } from '../llm/types'

/**
 * Component-level coverage for the setup screen's new controls: the
 * prompt/agent mode switch and its cost/time info text (REQ-LLM-380), and the
 * "annotate all papers" toggle's one-time consequences warning (REQ-LLM-390).
 * Everything else in `AiDialog` is exercised at the store level
 * (`aiStore.run.test.ts`, `aiStore.batch.test.ts`).
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
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [cfg()],
  saveLlmConfig: async () => [cfg()],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('../state/store')
const { useAiStore } = await import('../state/aiStore')
const { AiDialog } = await import('./AiDialog')

function cfg(): LlmConfig {
  return {
    id: 'c1',
    name: 'Test target',
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-x',
    attach: 'text',
    hasKey: true,
  }
}

const PROJECT = JSON.stringify({
  version: 1,
  title: 'Dialog',
  config: { schema: [{ name: 'Summary', type: 'string' }] },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()

beforeEach(async () => {
  st().loadFromText(PROJECT, null, 'test.json')
  st().selectPaper('p1')
  await useAiStore.getState().openDialog()
})

describe('mode switch: cost/time info text', () => {
  it('shows the prompt-mode explanation by default', () => {
    render(<AiDialog />)
    expect(screen.getByText(/model reads the paper once and proposes values/)).toBeInTheDocument()
  })

  it('switches to the agent-mode explanation, which states the extra cost and time', async () => {
    render(<AiDialog />)
    await userEvent.click(screen.getByRole('radio', { name: 'Agent' }))

    expect(useAiStore.getState().mode).toBe('agent')
    expect(
      screen.getByText(/considerably longer and costs considerably more/),
    ).toBeInTheDocument()
    expect(screen.getByText(/5–15 model requests per paper/)).toBeInTheDocument()
  })
})

describe('"annotate all papers": warn before it takes effect', () => {
  it('does not turn on immediately — a confirmation appears first', async () => {
    render(<AiDialog />)
    const toggle = screen.getByRole('checkbox', { name: 'Annotate all papers' })
    expect(toggle).not.toBeChecked()

    await userEvent.click(toggle)

    expect(useAiStore.getState().allPapers).toBe(false)
    expect(screen.getByText(/Every paper's content leaves this machine/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Current paper only' })).toBeInTheDocument()
  })

  it('turns on only once the reviewer confirms, naming the paper count', async () => {
    render(<AiDialog />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Annotate all papers' }))

    await userEvent.click(screen.getByRole('button', { name: /Annotate all 2 papers/ }))

    expect(useAiStore.getState().allPapers).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Annotate all papers' })).toBeChecked()
  })

  it('"Current paper only" backs out without turning it on', async () => {
    render(<AiDialog />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Annotate all papers' }))
    await userEvent.click(screen.getByRole('button', { name: 'Current paper only' }))

    expect(useAiStore.getState().allPapers).toBe(false)
    expect(screen.queryByRole('button', { name: /Annotate all 2 papers/ })).not.toBeInTheDocument()
  })
})

describe('renamed fields disclosure (REQ-LLM per the fields being sent, not "the prompt")', () => {
  it('summarizes which fields will be filled in, not "the prompt"', () => {
    render(<AiDialog />)
    expect(screen.getByText('Which fields will the AI fill in? (1)')).toBeInTheDocument()
    expect(screen.queryByText('Show the prompt')).not.toBeInTheDocument()
  })

  it('notes that only empty fields are sent', async () => {
    render(<AiDialog />)
    await userEvent.click(screen.getByText('Which fields will the AI fill in? (1)'))
    expect(
      screen.getByText(/Only these empty fields are sent to the AI/),
    ).toBeInTheDocument()
  })
})

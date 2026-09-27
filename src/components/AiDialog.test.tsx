import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

describe('judge picker (REQ-LLM-480)', () => {
  it('is hidden in prompt mode', () => {
    // `mode` persists across tests like a real setting — pin it rather than
    // rely on suite ordering (a sibling test switches to agent mode).
    useAiStore.setState({ mode: 'prompt' })
    render(<AiDialog />)
    expect(screen.queryByText('Judge')).not.toBeInTheDocument()
  })

  it('appears in agent mode, with "same as agent" as the default option', async () => {
    render(<AiDialog />)
    await userEvent.click(screen.getByRole('radio', { name: 'Agent' }))

    expect(screen.getByText('Judge')).toBeInTheDocument()
    expect(screen.getByDisplayValue(/Same as annotator \(Test target\)/)).toBeInTheDocument()
  })
})

describe('cost estimate line (REQ-LLM-430)', () => {
  it('shows the token/request range with a hint to add prices, when the target has none', () => {
    useAiStore.setState({ pageCounts: { p1: 10 } })
    render(<AiDialog />)

    expect(screen.getByText(/Estimated: ~/)).toBeInTheDocument()
    expect(screen.getByText(/Add prices in AI models settings to see a cost estimate/)).toBeInTheDocument()
  })

  it('shows a cost range once the selected target has prices', () => {
    useAiStore.setState({
      configs: [{ ...cfg(), inputPrice: 3, outputPrice: 15 }],
      pageCounts: { p1: 10 },
    })
    render(<AiDialog />)

    expect(screen.getByText(/≈ \$/)).toBeInTheDocument()
  })
})

describe('jump from an evidence quote to the PDF (REQ-LLM-460)', () => {
  it('makes a paper-sourced quote a button that switches paper, requests a PDF find, and peeks at the PDF', async () => {
    useAiStore.setState({
      phase: 'review',
      rows: [
        {
          paperId: 'p2',
          paperTitle: 'Paper Two',
          reviewer: null,
          checked: true,
          suggestion: { path: 'Summary', value: 'x', evidence: 'the quoted passage', confidence: null },
        },
      ],
      notes: [],
    })
    render(<AiDialog />)

    const evidenceButton = screen.getByRole('button', { name: /the quoted passage/ })
    await userEvent.click(evidenceButton)

    expect(st().currentPaperId).toBe('p2')
    expect(st().pdfFindRequest).toEqual({ paperId: 'p2', text: 'the quoted passage', nonce: 1 })
    expect(useAiStore.getState().minimized).toBe(true)
  })

  it('leaves a URL-sourced quote as plain text, not a button', () => {
    useAiStore.setState({
      phase: 'review',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          checked: true,
          suggestion: {
            path: 'Summary',
            value: 'x',
            evidence: 'from the web',
            confidence: null,
            source: 'https://example.com/paper',
          },
        },
      ],
      notes: [],
    })
    render(<AiDialog />)

    expect(screen.queryByRole('button', { name: /from the web/ })).not.toBeInTheDocument()
    expect(screen.getByText('from the web')).toBeInTheDocument()
  })

  it('peeking shows a "Back to AI review" button that restores the review table', async () => {
    useAiStore.setState({
      phase: 'review',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          checked: true,
          suggestion: { path: 'Summary', value: 'x', evidence: 'the quoted passage', confidence: null },
        },
      ],
      notes: [],
    })
    render(<AiDialog />)

    await userEvent.click(screen.getByRole('button', { name: /the quoted passage/ }))
    const backButton = screen.getByRole('button', { name: /Back to AI review/ })
    expect(screen.queryByRole('dialog', { name: 'Annotate with AI' })).not.toBeInTheDocument()

    await userEvent.click(backButton)
    expect(screen.getByRole('dialog', { name: 'Annotate with AI' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /the quoted passage/ })).toBeInTheDocument()
  })
})

describe('AI seat routing (REQ-LLM-470): setup screen says where answers go', () => {
  it('shows nothing extra in a single-reviewer project', () => {
    render(<AiDialog />)
    expect(screen.queryByText(/AI's own seat/)).not.toBeInTheDocument()
  })

  it("names the AI's own seat when the project has one, even with no reviewer picked", async () => {
    const withAiSeat = JSON.parse(PROJECT)
    withAiSeat.config.reviewers = 2
    withAiSeat.config.aiSeat = true
    st().loadFromText(JSON.stringify(withAiSeat), null, 'ai-seat.json')
    st().selectPaper('p1')
    expect(st().currentReviewer).toBeNull()
    await useAiStore.getState().openDialog()

    render(<AiDialog />)
    expect(screen.getByText(/AI's own seat/)).toBeInTheDocument()
    expect(screen.getByText('AI (Reviewer 2)')).toBeInTheDocument()
    expect(useAiStore.getState().targetSeat).toBe('2')
  })
})

describe('few-shot examples (REQ-LLM-450): setup screen toggle', () => {
  it('is disabled with no finished papers available', () => {
    render(<AiDialog />)
    const toggle = screen.getByRole('checkbox', { name: /finished papers as examples/ })
    expect(toggle).toBeDisabled()
    expect(screen.getByText(/No finished papers are available/)).toBeInTheDocument()
  })

  it('enables once a finished paper exists, and the consent line names the count', async () => {
    useStore.setState((s) => {
      s.project!.papers[1].finished = true
      s.project!.papers[1].annotations = { Summary: [{ value: 'x' }] }
    })
    await useAiStore.getState().openDialog()
    render(<AiDialog />)

    const toggle = screen.getByRole('checkbox', { name: /finished papers as examples/ })
    expect(toggle).not.toBeDisabled()
    expect(screen.getByText('1 finished paper available.')).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(useAiStore.getState().fewShot).toBe(true)
    expect(screen.getByText(/plus the annotations \(and abstracts\) of 1 of your finished papers/)).toBeInTheDocument()
  })
})

describe('parallel batch (REQ-LLM-500/510): setup screen controls', () => {
  it('shows the concurrency select only in all-papers mode', async () => {
    render(<AiDialog />)
    expect(screen.queryByLabelText('Papers at once')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: /Annotate all papers/ }))
    await userEvent.click(screen.getByRole('button', { name: /Annotate all/ }))

    expect(screen.getByLabelText('Papers at once')).toBeInTheDocument()
  })

  it('shows a resume banner when a saved batch exists for this project', async () => {
    localStorage.setItem(
      `slr.llm.batch.${st().project!.title}.`,
      JSON.stringify({
        version: 1,
        mode: 'prompt',
        configId: 'c1',
        judgeId: null,
        allPaperIds: ['p1', 'p2'],
        doneIds: ['p1'],
        usage: { calls: 1, inputTokens: 10, outputTokens: 5 },
        spent: 0,
        startedAt: new Date().toISOString(),
      }),
    )
    await useAiStore.getState().openDialog()
    render(<AiDialog />)

    expect(screen.getByText(/stopped after 1 of 2 papers/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })
})

describe('setup screen sections (Goal A restructure)', () => {
  it('renders the What/How/Models section labels in order', () => {
    render(<AiDialog />)
    const labels = ['What', 'How', 'Models', 'Annotator'].map((t) => screen.getByText(t))
    const positions = labels.map((el) => Array.from(document.querySelectorAll('.ai-label')).indexOf(el))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('collapses few-shot/concurrency/cap/threshold behind an "Options" details', () => {
    render(<AiDialog />)
    expect(screen.getByText('Options').closest('details')).toBeInTheDocument()
    expect(
      screen.getByText('Options').closest('details')!.querySelector('.ai-toggle-row'),
    ).not.toBeNull()
  })

  it('disables Classify mode when no System One model is configured', () => {
    render(<AiDialog />)
    expect(screen.getByRole('radio', { name: 'Classify' })).toBeDisabled()
  })
})

describe('Classify mode and cross-check (Goal B)', () => {
  function systemOneCfg(): LlmConfig {
    return {
      id: 's1',
      name: 'System One',
      provider: 'systemone',
      baseUrl: 'https://api.typesafe.ai',
      model: 'jev-latest',
      attach: 'text',
      hasKey: true,
    }
  }

  it('enables Classify mode once a System One model exists, and only offers System One models as annotator', async () => {
    useAiStore.setState({ configs: [cfg(), systemOneCfg()] })
    render(<AiDialog />)

    const classifyRadio = screen.getByRole('radio', { name: 'Classify' })
    expect(classifyRadio).not.toBeDisabled()
    await userEvent.click(classifyRadio)

    expect(screen.getByText(/Only yes\/no and single-choice fields/)).toBeInTheDocument()
    expect(useAiStore.getState().selectedId).toBe('s1')
  })

  it('offers a cross-check picker limited to System One models, in prompt/agent mode only', async () => {
    useAiStore.setState({ configs: [cfg(), systemOneCfg()], mode: 'prompt' })
    render(<AiDialog />)
    expect(screen.getByText('Cross-check (optional)')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: 'Classify' }))
    expect(screen.queryByText('Cross-check (optional)')).not.toBeInTheDocument()
  })

  it('hides the cross-check picker when no System One model is configured', () => {
    render(<AiDialog />)
    expect(screen.queryByText('Cross-check (optional)')).not.toBeInTheDocument()
  })
})

describe('Edit a proposal before applying (REQ-LLM-580)', () => {
  it('lets the reviewer edit a value: ticks the row and keeps the original AI value visible', async () => {
    useAiStore.setState({
      phase: 'review',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          checked: false,
          suggestion: { path: 'Summary', value: 'AI text', evidence: 'e', confidence: 0.5 },
        },
      ],
      notes: [],
    })
    render(<AiDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const input = screen.getByLabelText('Edited value')
    await userEvent.clear(input)
    await userEvent.type(input, 'reviewer text')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('reviewer text')).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.textContent === 'edited · AI proposed: AI text')).toBeInTheDocument()
    expect(useAiStore.getState().rows[0].checked).toBe(true)
    expect(useAiStore.getState().rows[0].edited).toBe(true)
  })

  it('shows a validation error and leaves the row unedited on an invalid value', async () => {
    useAiStore.setState({
      phase: 'review',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          checked: true,
          suggestion: { path: 'Summary', value: 'AI text', evidence: 'e', confidence: 0.5 },
        },
      ],
      notes: [],
    })
    render(<AiDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const input = screen.getByLabelText('Edited value')
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('empty value')).toBeInTheDocument()
    expect(useAiStore.getState().rows[0].edited).toBeFalsy()
  })

  it('Cancel discards the in-progress edit without touching the row', async () => {
    useAiStore.setState({
      phase: 'review',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          checked: true,
          suggestion: { path: 'Summary', value: 'AI text', evidence: 'e', confidence: 0.5 },
        },
      ],
      notes: [],
    })
    render(<AiDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('AI text')).toBeInTheDocument()
    expect(useAiStore.getState().rows[0].edited).toBeFalsy()
  })
})

describe('"Show only rows that need attention" filter (REQ-LLM-580)', () => {
  it('hides ticked, non-flagged rows once toggled on', async () => {
    useAiStore.setState({
      phase: 'review',
      rows: [
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          checked: true,
          flagged: false,
          suggestion: { path: 'Summary', value: 'confident value', evidence: 'e', confidence: 0.9 },
        },
        {
          paperId: 'p1',
          paperTitle: 'Paper One',
          reviewer: null,
          checked: false,
          flagged: true,
          suggestion: { path: 'Summary', value: 'low confidence value', evidence: 'e', confidence: 0.5 },
        },
      ],
      notes: [],
    })
    render(<AiDialog />)

    expect(screen.getByText('confident value')).toBeInTheDocument()
    expect(screen.getByText('low confidence value')).toBeInTheDocument()
    expect(screen.getByText(/1 row starts unticked/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show only rows that need attention' }))

    expect(screen.queryByText('confident value')).not.toBeInTheDocument()
    expect(screen.getByText('low confidence value')).toBeInTheDocument()
  })
})

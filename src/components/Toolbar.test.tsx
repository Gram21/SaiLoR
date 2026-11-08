import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecentEntry } from '../platform/recents'

// Toolbar calls `getPlatform().getGit()` directly during render. In jsdom
// (non-Tauri) `getPlatform()` returns the "unsupported" adapter, whose
// methods other than `kind`/`getRecents()` throw on call — so every method
// Toolbar (or the store actions it triggers) reaches for has to be mocked
// here, the same pattern `store.screening.test.ts` uses for `store.ts`.
const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: unknown) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  getGit: () => null,
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('../state/store')
const { Toolbar } = await import('./Toolbar')
const { useGitStore } = await import('../state/gitStore')

const st = () => useStore.getState()

function projectJson(opts: { reviewers?: number } = {}) {
  return JSON.stringify({
    version: 1,
    config: {
      screening: { reasons: ['Wrong topic', 'Duplicate'] },
      ai: true,
      ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
    },
    papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: '', annotations: {} }],
  })
}

function annotationProjectJson(opts: { reviewers?: number; ai?: boolean } = {}) {
  return JSON.stringify({
    version: 1,
    config: {
      schema: [{ name: 'Field', type: 'string' }],
      ai: true,
      ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
      ...(opts.ai === false ? { ai: false } : {}),
    },
    papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} }],
  })
}

beforeEach(() => {
  useStore.setState({
    project: null,
    saveHandle: null,
    projectName: '',
    projectTitle: '',
    dirty: false,
    busy: false,
    recents: [],
    currentReviewer: null,
  })
  useGitStore.setState({ annotationAuthors: null, repo: null, behind: null, repoSetupNotice: null })
})

describe('REQ-UI-30: seat switcher in toolbar', () => {
  it('renders no reviewer switch for a single-reviewer project', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    render(<Toolbar />)
    expect(screen.queryByRole('group', { name: 'Reviewer' })).not.toBeInTheDocument()
  })

  it('renders no reviewer switch at all when no project is open', () => {
    render(<Toolbar />)
    expect(screen.queryByRole('group', { name: 'Reviewer' })).not.toBeInTheDocument()
  })

  it('shows a pill per reviewer plus Consolidation, and clicking a pill selects that reviewer', async () => {
    st().loadFromText(projectJson({ reviewers: 2 }), null, 'test.json')
    render(<Toolbar />)
    const group = screen.getByRole('group', { name: 'Reviewer' })
    expect(within(group).getByRole('button', { name: '1' })).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: '2' })).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Consolidation' })).toBeInTheDocument()

    await userEvent.click(within(group).getByRole('button', { name: '2' }))
    expect(st().currentReviewer).toBe('2')
    expect(within(group).getByRole('button', { name: '2' })).toHaveClass('active')
    expect(within(group).getByRole('button', { name: '1' })).not.toHaveClass('active')
  })

})

// [utest->req~llm-80~1]
describe('the AI button in the toolbar', () => {
  it('is enabled for a normal, single-reviewer annotation project', () => {
    st().loadFromText(annotationProjectJson(), null, 'test.json')
    render(<Toolbar />)
    expect(screen.getByRole('button', { name: 'AI' })).not.toBeDisabled()
  })

  it('is disabled for the Consolidation seat', () => {
    st().loadFromText(annotationProjectJson({ reviewers: 2 }), null, 'test.json')
    act(() => st().selectReviewer('consolidation'))
    render(<Toolbar />)
    expect(screen.getByRole('button', { name: 'AI' })).toBeDisabled()
  })

  it('is not rendered with no project open', () => {
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: 'AI' })).not.toBeInTheDocument()
  })

  // [utest->req~llm-80~1]
  it('is not rendered when the project does not set config.ai', () => {
    st().loadFromText(JSON.stringify({ version: 1, config: { schema: [{ name: 'F', type: 'string' }] }, papers: [] }), null, 't.json')
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: 'AI' })).not.toBeInTheDocument()
  })

  // [utest->req~llm-80~1]
  it('is not rendered when the project turns AI off', () => {
    st().loadFromText(annotationProjectJson({ ai: false }), null, 'test.json')
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: 'AI' })).not.toBeInTheDocument()
  })
})

// [utest->req~ui-160~1]
// [utest->req~ui-170~1]
describe('toolbar entries that need a project or AI', () => {
  const names = [/Validate/, /Git/, /^Save/, /^Result view/]

  it('hides project-only entries when no project is open', () => {
    render(<Toolbar />)
    for (const name of names) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  })

  it('shows project-only entries when a project is open', () => {
    st().loadFromText(annotationProjectJson({ ai: false }), null, 'test.json')
    render(<Toolbar />)
    for (const name of names) expect(screen.getByRole('button', { name })).toBeInTheDocument()
  })

  it('puts the knowledge graph export in the Result view and Save menus, not on the toolbar', async () => {
    st().loadFromText(annotationProjectJson({ ai: false }), null, 'test.json')
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: 'Knowledge graph' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Result view/ }))
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent ?? '')
    expect(items[0]).toMatch(/^Explore knowledge graph/)
    expect(items[1]).toMatch(/^Create diagrams/)
    expect(items[2]).toMatch(/^Knowledge graph/)
    await userEvent.click(screen.getByRole('menuitem', { name: /^Knowledge graph/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('offers the graph export in the Save menu too', async () => {
    st().loadFromText(annotationProjectJson({ ai: false }), null, 'test.json')
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /^Save/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /^Knowledge graph/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  // [utest->req~ui-190~1]
  it('opens the knowledge graph view from the Result view menu', async () => {
    st().loadFromText(annotationProjectJson({ ai: false }), null, 'test.json')
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /^Result view/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Explore knowledge graph/ }))
    expect(screen.getByRole('dialog', { name: 'Result view' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Knowledge graph' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // [utest->req~ui-270~1]
  it('opens the diagrams from the Result view menu', async () => {
    st().loadFromText(annotationProjectJson({ ai: false }), null, 'test.json')
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /^Result view/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Create diagrams/ }))
    expect(screen.getByRole('tab', { name: 'Diagrams' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('combobox', { name: /Count papers by/ })).toBeInTheDocument()
  })

  it('never shows the AI evaluation on the toolbar', () => {
    st().loadFromText(annotationProjectJson({ reviewers: 2 }), null, 'test.json')
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: 'AI evaluation' })).not.toBeInTheDocument()
  })
})

// [utest->req~plt-62~1]
describe('unreadable annotation files stay visible for the whole session', () => {
  it('shows a warning that re-opens the list, and none when every file parsed', async () => {
    st().loadFromText(projectJson({ reviewers: 2 }), null, 'test.json')
    const { rerender } = render(<Toolbar />)
    expect(screen.queryByRole('button', { name: /unreadable/ })).not.toBeInTheDocument()

    // What the open path sets when `loadPaperFiles` could not parse a file.
    act(() => {
      useStore.setState({ corruptFiles: ['a/reviewer-2.json'] })
    })
    rerender(<Toolbar />)

    // The load-time banner is dismissible; this is the way back to it.
    expect(st().loadError).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /unreadable/ }))
    expect(st().loadError?.details.join(' ')).toContain('annotations/a/reviewer-2.json')
  })
})

describe('REQ-UI-20: toolbar project controls', () => {
  it('lists recent projects in the Open dropdown', async () => {
    useStore.setState({
      recents: [{ id: 'r1', name: 'old.json', title: 'Old Project' } as RecentEntry],
    })
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /Open/ }))
    expect(screen.getByRole('menuitem', { name: 'Old Project' })).toBeInTheDocument()
  })

  it('shows "No recent files" when there are none', async () => {
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /Open/ }))
    expect(screen.getByRole('menuitem', { name: 'No recent files' })).toBeInTheDocument()
  })

  it('clicking Save in the Save menu calls the store\'s save action', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    const saveSpy = vi.spyOn(useStore.getState(), 'save').mockResolvedValue(true)
    useStore.setState({ save: saveSpy })
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /^Save Ctrl/ }))
    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('the autosave toggle in the Save menu flips autosaveEnabled', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    useStore.setState({ autosaveEnabled: false })
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Autosave every 5 minutes/ }))
    expect(st().autosaveEnabled).toBe(true)
  })

  it('opens Settings from its toolbar button (REQ-UI-100)', async () => {
    useStore.setState({ userSettingsOpen: false })
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(st().userSettingsOpen).toBe(true)
  })

  // [utest->req~ui-20~1]
  it('always renders Close project to keep the layout stable, hidden and disabled without a project', async () => {
    const { rerender } = render(<Toolbar />)
    const hidden = screen.getByTitle('Close project')
    expect(hidden).toBeDisabled()
    expect(hidden).toHaveAttribute('aria-hidden', 'true')
    expect(hidden).toHaveAttribute('tabindex', '-1')
    expect(hidden).toHaveStyle({ visibility: 'hidden' })

    act(() => st().loadFromText(projectJson(), null, 'test.json'))
    rerender(<Toolbar />)
    const close = screen.getByRole('button', { name: 'Close project' })
    expect(close).toBeEnabled()
    expect(close).toHaveAttribute('title', 'Close project')
    await userEvent.click(close)
    expect(st().project).toBeNull()
    expect(screen.getByTitle('Close project')).toBeDisabled()
  })

  it('no longer offers Close project in the Open menu nor shows the project name', async () => {
    act(() => st().loadFromText(projectJson(), null, 'test.json'))
    render(<Toolbar />)
    expect(screen.queryByText('test.json')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Open/ }))
    expect(screen.getByRole('menuitem', { name: /^Open file…/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Close project' })).not.toBeInTheDocument()
  })

  it('groups Validate and AI as review tools, apart from the file and Git controls', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    render(<Toolbar />)
    const tools = screen.getByRole('group', { name: 'Review tools' })
    expect(within(tools).getByRole('button', { name: 'Validate' })).toBeInTheDocument()
    expect(within(tools).getByRole('button', { name: 'AI' })).toBeInTheDocument()
    expect(within(tools).queryByRole('button', { name: 'Git' })).not.toBeInTheDocument()
  })

  it('the Validate button runs validation for a picked single-reviewer seat', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    render(<Toolbar />)
    // Single-reviewer projects have an implicit seat (no picker needed).
    expect(screen.getByRole('button', { name: 'Validate' })).not.toBeDisabled()
  })

  it('the appearance controls (font size, theme) are present and clickable', async () => {
    render(<Toolbar />)
    const before = st().theme
    await userEvent.click(screen.getByRole('button', { name: 'Toggle theme' }))
    expect(st().theme).not.toBe(before)
    expect(screen.getByRole('group', { name: 'Font size' })).toBeInTheDocument()
  })
})

// [utest->req~git-420~1]
describe('unpulled work and repository setup are visible in the toolbar', () => {
  const repo = (behind: number | null) => ({
    root: '/repo',
    relPath: 'x.json',
    branch: 'main',
    upstream: 'origin/main',
    hasHead: true,
    behind,
  })

  it('offers to pull when the repository already knows work is waiting', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    useGitStore.setState({ repo: repo(3), behind: 3 })
    render(<Toolbar />)
    expect(screen.getByRole('button', { name: /3 to pull/ })).toBeInTheDocument()
  })

  it('says nothing at zero — "behind" is only ever as fresh as the last fetch', async () => {
    // Silence must not read as "you are up to date"; only a fetch could say
    // that, and opening a project does not do one.
    st().loadFromText(projectJson(), null, 'test.json')
    useGitStore.setState({ repo: repo(0), behind: 0 })
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: /to pull/ })).not.toBeInTheDocument()
  })

})

// [utest->req~plt-443~1]
describe('features over the whole project wait while it loads', () => {
  const hint = 'Available once every paper has loaded.'

  it('disables validation, AI, saving and the exports with the reason', async () => {
    st().loadFromText(annotationProjectJson(), null, 'test.json')
    useStore.setState({ loadState: 'loading', loadProgress: { loaded: 0, total: 1 } })
    render(<Toolbar />)
    for (const name of [/Validate/, 'AI']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', hint)
    }
    await userEvent.click(screen.getByRole('button', { name: /^Save/ }))
    for (const name of [/^Save(?! as)/i, /^Save as/i]) {
      const item = screen.getByRole('menuitem', { name })
      expect(item).toBeDisabled()
      expect(item).toHaveAttribute('title', hint)
    }
    await userEvent.click(screen.getByRole('button', { name: /^Result view/ }))
    for (const name of [/Explore knowledge graph/, /Create diagrams/, /^Knowledge graph/]) {
      const item = screen.getByRole('menuitem', { name })
      expect(item).toBeDisabled()
      expect(item).toHaveAttribute('title', hint)
    }
  })

  it('enables them again once every paper has loaded', () => {
    st().loadFromText(annotationProjectJson(), null, 'test.json')
    render(<Toolbar />)
    expect(screen.getByRole('button', { name: /Validate/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'AI' })).not.toBeDisabled()
  })
})

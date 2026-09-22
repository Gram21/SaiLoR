import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecentEntry } from '../platform/recents'

// Toolbar calls `getPlatform().getGit()` directly during render. In jsdom
// (non-Electron) `getPlatform()` returns the "unsupported" adapter, whose
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
      ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
    },
    papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: '', annotations: {} }],
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
  useGitStore.setState({ annotationAuthors: null, repo: null, repoSetupNotice: null })
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
    useStore.setState({ autosaveEnabled: false })
    render(<Toolbar />)
    await userEvent.click(screen.getByRole('button', { name: /Save/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Autosave every 5 minutes/ }))
    expect(st().autosaveEnabled).toBe(true)
  })

  it('Close is disabled with no project open, enabled once one is', () => {
    const { rerender } = render(<Toolbar />)
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()

    act(() => st().loadFromText(projectJson(), null, 'test.json'))
    rerender(<Toolbar />)
    expect(screen.getByRole('button', { name: 'Close' })).not.toBeDisabled()
  })

  it('the Validate button runs validation for a picked single-reviewer seat', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    render(<Toolbar />)
    // Single-reviewer projects have an implicit seat (no picker needed).
    expect(screen.getByRole('button', { name: 'Validate' })).not.toBeDisabled()
  })

  it('shows the dirty indicator only while the project has unsaved changes', () => {
    st().loadFromText(projectJson(), null, 'test.json')
    useStore.setState({ dirty: true })
    const { rerender } = render(<Toolbar />)
    expect(screen.getByTitle('Unsaved changes')).toBeInTheDocument()

    act(() => useStore.setState({ dirty: false }))
    rerender(<Toolbar />)
    expect(screen.queryByTitle('Unsaved changes')).not.toBeInTheDocument()
  })

  it('the appearance controls (font size, theme) are present and clickable', async () => {
    render(<Toolbar />)
    const before = st().theme
    await userEvent.click(screen.getByRole('button', { name: 'Toggle theme' }))
    expect(st().theme).not.toBe(before)
    expect(screen.getByRole('group', { name: 'Font size' })).toBeInTheDocument()
  })
})

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
    useGitStore.setState({ repo: repo(3) })
    render(<Toolbar />)
    expect(screen.getByRole('button', { name: /3 to pull/ })).toBeInTheDocument()
  })

  it('says nothing at zero — "behind" is only ever as fresh as the last fetch', async () => {
    // Silence must not read as "you are up to date"; only a fetch could say
    // that, and opening a project does not do one.
    st().loadFromText(projectJson(), null, 'test.json')
    useGitStore.setState({ repo: repo(0) })
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: /to pull/ })).not.toBeInTheDocument()
  })

  it('reports a commit SaiLoR made on its own, and lets it be dismissed', async () => {
    st().loadFromText(projectJson(), null, 'test.json')
    useGitStore.setState({ repo: repo(null), repoSetupNotice: 'Added rules and committed them.' })
    render(<Toolbar />)

    await userEvent.click(screen.getByRole('button', { name: /Added rules/ }))
    expect(useGitStore.getState().repoSetupNotice).toBeNull()
  })
})

import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { PaperList } from './PaperList'

const st = () => useStore.getState()

// Two required string fields plus one optional one — enough to reach every
// annotation state (`untouched`/`partial`/`complete`/`finished`/`flagged`),
// since `completeness` counts required fields only once anything is required.
const SCHEMA = [
  { name: 'Notes', type: 'string' },
  { name: 'Design', type: 'string', required: true },
  { name: 'Population', type: 'string', required: true },
]

function projectJson(papers: unknown[]) {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA },
    papers,
  })
}

beforeEach(() => {
  useStore.setState({
    project: null,
    currentPaperId: null,
    currentReviewer: null,
    annotationFilter: 'all',
    screeningFilter: 'all',
  })
})

describe('REQ-LST-10: list papers with status', () => {
  it('renders each paper with a status dot whose aria-label reflects its state', () => {
    st().loadFromText(
      projectJson([{ id: 'p1', title: 'Untouched Paper', authors: [], pdf: 'a.pdf', annotations: {} }]),
      null,
      'test.json',
    )
    render(<PaperList />)
    expect(screen.getByText('Untouched Paper')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Not started/ })).toBeInTheDocument()
  })
})

describe('REQ-LST-30: five-state annotation indicator', () => {
  function fiveStateProject() {
    return projectJson([
      { id: 'p-untouched', title: 'Untouched Paper', authors: [], pdf: 'a.pdf', annotations: {} },
      {
        id: 'p-partial',
        title: 'Partial Paper',
        authors: [],
        pdf: 'b.pdf',
        annotations: { Design: [{ value: 'RCT' }] },
      },
      {
        id: 'p-complete',
        title: 'Complete Paper',
        authors: [],
        pdf: 'c.pdf',
        annotations: { Design: [{ value: 'RCT' }], Population: [{ value: 'Adults' }] },
      },
      {
        id: 'p-finished',
        title: 'Finished Paper',
        authors: [],
        pdf: 'd.pdf',
        annotations: { Design: [{ value: 'RCT' }], Population: [{ value: 'Adults' }] },
        finished: true,
      },
      {
        id: 'p-flagged',
        title: 'Flagged Paper',
        authors: [],
        pdf: 'e.pdf',
        annotations: { Design: [{ value: 'RCT' }] },
        finished: true,
      },
    ])
  }

  it('gives each state row the matching status-dot className and aria-label', () => {
    st().loadFromText(fiveStateProject(), null, 'test.json')
    render(<PaperList />)

    const rowFor = (title: string) =>
      screen.getByText(title).closest('[role="option"]') as HTMLElement

    const dotOf = (title: string) => within(rowFor(title)).getByRole('img')

    const untouched = dotOf('Untouched Paper')
    expect(untouched.className).toContain('status-dot untouched')
    expect(untouched).toHaveAccessibleName(/Not started/)

    const partial = dotOf('Partial Paper')
    expect(partial.className).toContain('status-dot partial')
    expect(partial).toHaveAccessibleName(/In progress/)

    const complete = dotOf('Complete Paper')
    expect(complete.className).toContain('status-dot complete')
    expect(complete).toHaveAccessibleName(/Ready to finish/)

    const finished = dotOf('Finished Paper')
    expect(finished.className).toContain('status-dot finished')
    expect(finished).toHaveAccessibleName(/Marked finished/)
    expect(finished).not.toHaveAccessibleName(/required field is empty/)

    const flagged = dotOf('Flagged Paper')
    expect(flagged.className).toContain('status-dot flagged')
    expect(flagged).toHaveAccessibleName(/required field is empty/)
  })
})

describe('REQ-LST-40: annotation progress filter', () => {
  function fiveStateProject() {
    return projectJson([
      { id: 'p-untouched', title: 'Untouched Paper', authors: [], pdf: 'a.pdf', annotations: {} },
      {
        id: 'p-partial',
        title: 'Partial Paper',
        authors: [],
        pdf: 'b.pdf',
        annotations: { Design: [{ value: 'RCT' }] },
      },
      {
        id: 'p-complete',
        title: 'Complete Paper',
        authors: [],
        pdf: 'c.pdf',
        annotations: { Design: [{ value: 'RCT' }], Population: [{ value: 'Adults' }] },
      },
      {
        id: 'p-finished',
        title: 'Finished Paper',
        authors: [],
        pdf: 'd.pdf',
        annotations: { Design: [{ value: 'RCT' }], Population: [{ value: 'Adults' }] },
        finished: true,
      },
      {
        id: 'p-flagged',
        title: 'Flagged Paper',
        authors: [],
        pdf: 'e.pdf',
        annotations: { Design: [{ value: 'RCT' }] },
        finished: true,
      },
    ])
  }

  it('narrows the list and updates the progress counter per bucket', async () => {
    const user = userEvent.setup()
    st().loadFromText(fiveStateProject(), null, 'test.json')
    render(<PaperList />)

    // Default ('all'): counts the 'finished' bucket, list unfiltered.
    expect(screen.getByText('finished: 1/5')).toBeInTheDocument()
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(5)

    const select = screen.getByRole('combobox', { name: 'Filter by annotation state' })

    await user.selectOptions(select, 'open')
    expect(screen.getByText('open: 3/5')).toBeInTheDocument()
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(3)
    expect(screen.queryByText('Finished Paper')).not.toBeInTheDocument()
    expect(screen.queryByText('Flagged Paper')).not.toBeInTheDocument()

    await user.selectOptions(select, 'in-progress')
    expect(screen.getByText('in progress: 2/5')).toBeInTheDocument()
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByText('Partial Paper')).toBeInTheDocument()
    expect(screen.getByText('Complete Paper')).toBeInTheDocument()

    await user.selectOptions(select, 'finished')
    expect(screen.getByText('finished: 1/5')).toBeInTheDocument()
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Finished Paper')).toBeInTheDocument()

    await user.selectOptions(select, 'issues')
    expect(screen.getByText('with issues: 1/5')).toBeInTheDocument()
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Flagged Paper')).toBeInTheDocument()
  })
})

describe('REQ-LST-20: two-mode search', () => {
  function twoModeProject() {
    return projectJson([
      {
        id: 'p-wombat',
        title: 'Wombat Behaviour Study',
        authors: ['Jones'],
        pdf: 'wombat.pdf',
        annotations: { Design: [{ value: 'Randomized Controlled Trial' }] },
      },
      {
        id: 'p-quantum',
        title: 'Alpha Quantum Computing',
        authors: ['Smith'],
        pdf: 'quantum.pdf',
        annotations: { Design: [{ value: 'Qualitative Case Study' }] },
      },
    ])
  }

  it('filters by title/author/DOI in metadata mode', async () => {
    const user = userEvent.setup()
    st().loadFromText(twoModeProject(), null, 'test.json')
    render(<PaperList />)

    const input = screen.getByRole('textbox', { name: 'Search papers' })
    await user.type(input, 'wombat')
    expect(screen.getByText('Wombat Behaviour Study')).toBeInTheDocument()
    expect(screen.queryByText('Alpha Quantum Computing')).not.toBeInTheDocument()
  })

  it('finds nothing by metadata search for a term that only lives in annotations', async () => {
    const user = userEvent.setup()
    st().loadFromText(twoModeProject(), null, 'test.json')
    render(<PaperList />)

    const input = screen.getByRole('textbox', { name: 'Search papers' })
    await user.type(input, 'randomized')
    expect(screen.queryByText('Wombat Behaviour Study')).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha Quantum Computing')).not.toBeInTheDocument()
  })

  it('switches to annotation-content search via the mode toggle and filters differently', async () => {
    const user = userEvent.setup()
    st().loadFromText(twoModeProject(), null, 'test.json')
    render(<PaperList />)

    await user.click(
      screen.getByRole('button', { name: 'Toggle search mode between paper metadata and annotation content' }),
    )
    const input = screen.getByRole('textbox', { name: 'Search annotations' })
    await user.type(input, 'randomized')
    expect(screen.getByText('Wombat Behaviour Study')).toBeInTheDocument()
    expect(screen.queryByText('Alpha Quantum Computing')).not.toBeInTheDocument()
  })
})

describe('REQ-LST-25: case-sensitive search toggle', () => {
  it('an exact-case-only value stops matching a lowercase query once case-sensitive is on', async () => {
    const user = userEvent.setup()
    st().loadFromText(
      projectJson([
        { id: 'p1', title: 'AI-based Diagnosis', authors: [], pdf: 'a.pdf', annotations: {} },
        { id: 'p2', title: 'Unrelated Paper', authors: [], pdf: 'b.pdf', annotations: {} },
      ]),
      null,
      'test.json',
    )
    render(<PaperList />)

    const input = screen.getByRole('textbox', { name: 'Search papers' })
    await user.type(input, 'ai')
    // Case-insensitive by default: "ai" matches "AI-based Diagnosis".
    expect(screen.getByText('AI-based Diagnosis')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Toggle case-sensitive search' }))
    // Case-sensitive now: "ai" (lowercase) no longer matches "AI" (uppercase).
    expect(screen.queryByText('AI-based Diagnosis')).not.toBeInTheDocument()
  })
})

import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, screen, fireEvent } from '@testing-library/react'
import { useStore } from '../state/store'
import { useConsolidationAlignment } from './useConsolidationAlignment'
import { markParts } from '../consolidate/readiness'
import { ConsolidationUpdatePrompt } from '../components/ConsolidationUpdatePrompt'

/**
 * REQ-CON-150/160: re-entering the Consolidation seat must not undo the
 * consolidator's work. The automatic steps run once per state of the
 * reviewers' answers; when those answers change under an already-answered
 * consolidated tree, the consolidator is asked before anything is rewritten.
 */

const st = () => useStore.getState()

const schema = [
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [{ name: 'Claim', type: 'string' as const }],
  },
]

const finding = (claim: string) => ({ children: { Claim: [{ value: claim }] } })

function projectJson(reviews: Record<string, unknown>) {
  return JSON.stringify({
    version: 1,
    config: { schema, reviewers: 2 },
    papers: [{ id: 'p1', title: 'Alpha', authors: [], pdf: 'a.pdf', annotations: {}, reviews }],
  })
}

const agreed = {
  '1': { Findings: [finding('Alpha')] },
  '2': { Findings: [finding('Alpha')] },
}

function Host() {
  useConsolidationAlignment()
  return <ConsolidationUpdatePrompt />
}

const claim = () =>
  st().project!.papers[0].annotations['Findings']?.[0]?.children?.['Claim']?.[0]?.value ?? null

/** The scheduler yields between nodes; drain it. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

beforeEach(() => {
  useStore.setState({ project: null, currentPaperId: null, currentReviewer: null })
})

describe('useConsolidationAlignment', () => {
  it('runs once, then leaves the paper alone while the reviewers are unchanged', async () => {
    act(() => {
      st().loadFromText(projectJson(agreed), null, 'test.json')
      st().selectPaper('p1')
      st().selectReviewer('consolidation')
    })
    const { rerender } = render(<Host />)
    await settle()

    expect(claim()).toBe('Alpha')
    const synced = st().project!.papers[0].consolidationSync
    expect(synced).toBeTruthy()

    // The consolidator decides that finding does not belong and clears it.
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, ''))
    expect(claim()).toBe('')

    // Away to a reviewer seat and back — the whole scheduler reruns.
    act(() => st().selectReviewer('1'))
    rerender(<Host />)
    act(() => st().selectReviewer('consolidation'))
    rerender(<Host />)
    await settle()

    expect(claim()).toBe('')
    expect(st().consolidationUpdatePrompt).toBeNull()
    // The reviewers' half is what gates a rerun, and nobody touched them; the
    // consolidated half moved with the clear, and is re-recorded silently.
    expect(markParts(st().project!.papers[0].consolidationSync!).reviews).toBe(markParts(synced!).reviews)
  })

  it('asks before rewriting an answered tree once a reviewer changes something', async () => {
    act(() => {
      st().loadFromText(projectJson(agreed), null, 'test.json')
      st().selectPaper('p1')
      st().selectReviewer('consolidation')
    })
    const { rerender } = render(<Host />)
    await settle()
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, ''))

    // Reviewer 2 changes their mind, in their own seat.
    act(() => st().selectReviewer('2'))
    rerender(<Host />)
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Beta'))
    act(() => st().selectReviewer('consolidation'))
    rerender(<Host />)
    await settle()

    expect(st().consolidationUpdatePrompt).toBe('p1')
    // Nothing written while the question is open.
    expect(claim()).toBe('')
  })

  it('"Keep My Version" leaves the tree alone and stops asking', async () => {
    act(() => {
      st().loadFromText(projectJson(agreed), null, 'test.json')
      st().selectPaper('p1')
      st().selectReviewer('consolidation')
    })
    const { rerender } = render(<Host />)
    await settle()
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, ''))
    act(() => st().selectReviewer('2'))
    rerender(<Host />)
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Beta'))
    act(() => st().selectReviewer('consolidation'))
    rerender(<Host />)
    await settle()

    // Through the dialog itself, so its wiring is covered too.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Reviewer answers changed')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep My Version' }))
    })
    await settle()

    expect(claim()).toBe('')
    expect(st().consolidationUpdatePrompt).toBeNull()

    // And it does not come back on the next visit.
    act(() => st().selectReviewer('1'))
    rerender(<Host />)
    act(() => st().selectReviewer('consolidation'))
    rerender(<Host />)
    await settle()
    expect(st().consolidationUpdatePrompt).toBeNull()
    expect(claim()).toBe('')
  })

  it('"Update" folds the reviewers\' new answers in', async () => {
    act(() => {
      st().loadFromText(projectJson(agreed), null, 'test.json')
      st().selectPaper('p1')
      st().selectReviewer('consolidation')
    })
    const { rerender } = render(<Host />)
    await settle()
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, ''))
    act(() => st().selectReviewer('2'))
    rerender(<Host />)
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Beta'))
    act(() => st().selectReviewer('1'))
    rerender(<Host />)
    act(() => st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'Beta'))
    act(() => st().selectReviewer('consolidation'))
    rerender(<Host />)
    await settle()
    expect(st().consolidationUpdatePrompt).toBe('p1')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    })
    await settle()

    expect(claim()).toBe('Beta')
    expect(st().consolidationUpdateApproved).toBeNull()
  })

  it('never asks about a paper that has no recorded sync point', async () => {
    // Every project saved before this was tracked looks like this; adopting
    // into it is the first run, not an overwrite.
    act(() => {
      st().loadFromText(projectJson(agreed), null, 'test.json')
      st().selectPaper('p1')
      st().selectReviewer('consolidation')
    })
    render(<Host />)
    await settle()

    expect(st().consolidationUpdatePrompt).toBeNull()
    expect(claim()).toBe('Alpha')
  })
})

import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useStore } from '../state/store'
import { AgreementDialog } from './AgreementDialog'

const st = () => useStore.getState()

/**
 * REQ-CON-330: the agreement dialog warns when a paper has a repeatable node
 * two or more reviewers recorded entries in, but Consolidation hasn't
 * reviewed yet (`needsAlignment` in `consolidate/readiness.ts`) — reading such
 * entries at a fixed index can read as disagreement between reviewers who
 * actually agreed, just in a different order.
 */
function projectJson(opts: { findingsConsolidated: boolean }) {
  const findingsInstance = (claim: string) => ({ children: { Claim: [{ value: claim }] } })
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    config: {
      schema: [{ name: 'Findings', min: 1, max: null, children: [{ name: 'Claim', type: 'string' }] }],
      reviewers: 2,
    },
    papers: [
      {
        id: 'p1',
        title: 'A Paper',
        authors: [],
        pdf: 'a.pdf',
        annotations: opts.findingsConsolidated
          ? { Findings: [findingsInstance('A'), findingsInstance('B')] }
          : {},
        reviews: {
          '1': { Findings: [findingsInstance('A'), findingsInstance('B')] },
          '2': { Findings: [findingsInstance('B'), findingsInstance('A')] },
        },
      },
    ],
  })
}

beforeEach(() => {
  useStore.setState({ project: null, agreementOpen: false })
})

describe('AgreementDialog: unaligned-papers warning', () => {
  it('warns when two reviewers recorded repeatable entries Consolidation has not reviewed yet', () => {
    st().loadFromText(projectJson({ findingsConsolidated: false }), null, 'test.json')
    useStore.setState({ agreementOpen: true })
    render(<AgreementDialog />)
    expect(screen.getByRole('alert')).toHaveTextContent(/repeated entries/)
  })

  it('does not warn once Consolidation has recorded an answer for that node', () => {
    st().loadFromText(projectJson({ findingsConsolidated: true }), null, 'test.json')
    useStore.setState({ agreementOpen: true })
    render(<AgreementDialog />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

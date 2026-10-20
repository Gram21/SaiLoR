import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AiUsageRecord, Project } from '../model/project'
import { AiUsageDisclosure } from './AiUsageDisclosure'

// REQ-LLM-570: the per-paper AI-usage disclosure.

const project: Pick<Project, 'aiSeat' | 'aiEnabled' | 'reviewers' | 'screening'> = {
  aiSeat: true,
  aiEnabled: true,
  reviewers: 2,
  screening: null,
}

describe('AiUsageDisclosure', () => {
  it('renders nothing given an empty record list', () => {
    const { container } = render(<AiUsageDisclosure project={project} records={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a count and expands to provider/model, judge, rounds, verdicts and seat', () => {
    const records: AiUsageRecord[] = [
      {
        provider: 'openai',
        model: 'gpt-5.5',
        appliedAt: '2026-01-01T00:00:00.000Z',
        mode: 'agent',
        judge: { provider: 'anthropic', model: 'claude-x' },
        rounds: 2,
        verdicts: { accept: 3, revise: 1, reject: 0 },
        fewShot: 4,
        edited: 3,
        reviewer: '2',
      },
    ]
    render(<AiUsageDisclosure project={project} records={records} />)
    expect(screen.getByText('✦ AI-assisted (1×)')).toBeInTheDocument()
    expect(screen.getByText(/OpenAI · gpt-5\.5/)).toBeInTheDocument()
    expect(screen.getByText(/judge Anthropic · claude-x/)).toBeInTheDocument()
    expect(screen.getByText(/2 rounds/)).toBeInTheDocument()
    expect(screen.getByText(/3 accepted, 1 revised, 0 rejected/)).toBeInTheDocument()
    expect(screen.getByText(/4 examples/)).toBeInTheDocument()
    expect(screen.getByText(/3 edited/)).toBeInTheDocument()
    expect(screen.getByText(/AI \(Reviewer 2\)/)).toBeInTheDocument()
  })

  it('omits the edited count when zero or absent', () => {
    const records: AiUsageRecord[] = [
      { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-01-01T00:00:00.000Z', edited: 0 },
    ]
    render(<AiUsageDisclosure project={project} records={records} />)
    expect(screen.queryByText(/edited/)).not.toBeInTheDocument()
  })

  it('shows a count for multiple records', () => {
    const records: AiUsageRecord[] = [
      { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-01-01T00:00:00.000Z' },
      { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-01-02T00:00:00.000Z' },
    ]
    render(<AiUsageDisclosure project={project} records={records} />)
    expect(screen.getByText('✦ AI-assisted (2×)')).toBeInTheDocument()
  })

  it('falls back to the raw provider id when unknown, and handles an unrecognized mode string gracefully', () => {
    const records: AiUsageRecord[] = [
      // A future mode value (e.g. "classify") another agent may add: this
      // component must render it as-is rather than crash on an unexpected string.
      { provider: 'some-future-provider', model: 'm1', appliedAt: '2026-01-01T00:00:00.000Z', mode: 'classify' as AiUsageRecord['mode'] },
    ]
    render(<AiUsageDisclosure project={project} records={records} />)
    expect(screen.getByText(/some-future-provider · m1/)).toBeInTheDocument()
    expect(screen.getByText(/classify/)).toBeInTheDocument()
  })

  it('defaults to "prompt" for a record predating the mode distinction', () => {
    const records: AiUsageRecord[] = [{ provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-01-01T00:00:00.000Z' }]
    render(<AiUsageDisclosure project={project} records={records} />)
    expect(screen.getByText(/prompt/)).toBeInTheDocument()
  })

  it('shows replaced answers and web searches only when present', () => {
    const base = { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-01-01T00:00:00.000Z' }
    render(<AiUsageDisclosure project={project} records={[{ ...base, rechecked: 2, webSearches: 1 }]} />)
    expect(screen.getByText(/2 replaced/)).toBeInTheDocument()
    expect(screen.getByText(/1 web search(?!es)/)).toBeInTheDocument()
  })
})

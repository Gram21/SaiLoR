import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from '../state/store'
import { SchemaInfoDialog } from './SchemaInfoDialog'

const st = () => useStore.getState()

function projectJson(schemaInfo: string | null) {
  return JSON.stringify({
    version: 1,
    title: 'My Review',
    schemaInfo,
    config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
    papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

beforeEach(() => {
  useStore.setState({ project: null, schemaInfoOpen: false })
})

describe('SchemaInfoDialog: shown once per load', () => {
  it('opens automatically when the loaded project has a schema comment', () => {
    st().loadFromText(projectJson('Read the protocol before annotating.'), null, 'test.json')
    render(<SchemaInfoDialog />)
    expect(screen.getByRole('dialog', { name: 'About this schema' })).toBeInTheDocument()
    expect(screen.getByText('Read the protocol before annotating.')).toBeInTheDocument()
  })

  it('does not appear when the project has no schema comment', () => {
    st().loadFromText(projectJson(null), null, 'test.json')
    render(<SchemaInfoDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closing it does not reopen it on its own — only a fresh load (or the ⓘ button) does', async () => {
    st().loadFromText(projectJson('Read the protocol before annotating.'), null, 'test.json')
    render(<SchemaInfoDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Same project, no new load: still closed.
    expect(st().schemaInfoOpen).toBe(false)
  })

  it('re-opens on a subsequent load of a project that has a comment', () => {
    st().loadFromText(projectJson(null), null, 'a.json')
    st().setSchemaInfoOpen(false)
    st().loadFromText(projectJson('New protocol note.'), null, 'b.json')
    render(<SchemaInfoDialog />)
    expect(screen.getByText('New protocol note.')).toBeInTheDocument()
  })
})

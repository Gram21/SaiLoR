import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DemoBanner } from './DemoBanner'

vi.mock('../demo/schemaMode', () => ({ DEMO_SCHEMA_MODE: true }))

// [utest->req~plt-456~1]
describe('DemoBanner in the schema editor demo', () => {
  it('says that save downloads project.json and keeps the link back', () => {
    render(<DemoBanner />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Schema demo: nothing is saved on this site. Save downloads project.json.',
    )
    expect(screen.getByRole('link', { name: '← Back to project page' })).toHaveAttribute('href', '../')
  })
})

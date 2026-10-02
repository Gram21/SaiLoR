import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AiPreviewNotice } from './AiPreviewNotice'

describe('AiPreviewNotice', () => {
  it('tells the user the AI support is a preview', () => {
    render(<AiPreviewNotice />)
    expect(screen.getByRole('note')).toHaveTextContent(/preview feature/i)
  })
})

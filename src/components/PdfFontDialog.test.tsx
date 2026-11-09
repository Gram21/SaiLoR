// [utest->req~ui-370~1]
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PdfFontDialog } from './PdfFontDialog'

const chars = ['中', '文']

describe('PdfFontDialog', () => {
  it('offers to embed a font or to save SVG, and tells the size of the font', async () => {
    const onChoose = vi.fn()
    render(<PdfFontDialog chars={chars} search={{ found: { font: new Uint8Array(3 * 1_048_576) } }} onChoose={onChoose} />)
    expect(screen.getByText(/中 文/)).toBeInTheDocument()
    expect(screen.getByText(/about 3\.0 MB/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Embed font' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save as SVG' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChoose.mock.calls).toEqual([['embed'], ['svg'], [null]])
  })

  it.each([
    ['shaping', /needs text shaping/],
    ['no-font', /found no installed font file/],
    ['uncovered', /No installed font .* has these characters: 中 文/],
  ] as const)('gives the reason why only SVG is offered: %s', (why, reason) => {
    render(<PdfFontDialog chars={chars} search={{ missing: chars, why }} onChoose={() => {}} />)
    expect(screen.getByText(/Only SVG is offered/)).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(reason)
    expect(screen.queryByRole('button', { name: 'Embed font' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save as SVG' })).toBeInTheDocument()
  })
})

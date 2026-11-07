import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../state/store'
import { demoArxivUrl } from './text'

vi.mock('./mode', () => ({ DEMO_MODE: true }))

vi.mock('../platform', async () => {
  const { createDemoAdapter } = await import('../platform/demoAdapter')
  const demo = createDemoAdapter()
  return { getPlatform: () => demo }
})

const st = () => useStore.getState()

// [utest->req~plt-452~1]
describe('demo start', () => {
  beforeEach(async () => {
    await st().openProject()
  })

  it('opens on the paper with the bundled PDF, in reviewer 1 seat, without the seat prompt', () => {
    expect(st().currentPaperId).toBe('KeimKaplan2026_ICSEBoF')
    expect(st().currentReviewer).toBe('1')
  })

  it('lets the visitor switch seats after the start', () => {
    st().selectReviewer('2')
    expect(st().currentReviewer).toBe('2')
  })
})

// [utest->req~plt-453~1]
describe('demoArxivUrl', () => {
  it('takes the arXiv abstract page from the venue text', () => {
    expect(demoArxivUrl("ICSE-Companion '26 (arXiv: https://arxiv.org/abs/2601.19548)")).toBe(
      'https://arxiv.org/abs/2601.19548',
    )
  })

  it('returns null when the venue names no arXiv page', () => {
    expect(demoArxivUrl('Journal of Things')).toBeNull()
    expect(demoArxivUrl(undefined)).toBeNull()
  })
})

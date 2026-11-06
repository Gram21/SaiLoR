import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../state/store'
import { DEMO_NOT_SAVED } from './text'

vi.mock('../platform', async () => {
  const { createDemoAdapter } = await import('../platform/demoAdapter')
  const demo = createDemoAdapter()
  return { getPlatform: () => demo }
})

const st = () => useStore.getState()

// [utest->req~plt-445~1]
// [utest->req~plt-446~1]
describe('demo session in the store', () => {
  let setItem: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    setItem = vi.spyOn(Storage.prototype, 'setItem')
    await st().openProject()
  })

  it('opens the bundled project into the store', () => {
    expect(st().project?.papers).toHaveLength(7)
    expect(st().loadError).toBeNull()
  })

  it('keeps an edit in memory, refuses to save it, and drops it on reopen', async () => {
    st().selectReviewer('2')
    st().selectPaper('Schmid2025_ArchLLMs')
    st().setFieldValue([], 'Notes', 0, 'Edited by a visitor')
    expect(st().dirty).toBe(true)

    expect(await st().save()).toBe(false)
    expect(st().loadError?.message).toBe(DEMO_NOT_SAVED)
    expect(st().dirty).toBe(true)
    expect(setItem).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Edited by a visitor'))

    await st().openProject()
    st().selectReviewer('2')
    st().selectPaper('Schmid2025_ArchLLMs')
    expect(st().project?.papers.find((p) => p.id === 'Schmid2025_ArchLLMs')?.reviews['2']?.Notes?.[0]?.value).toBe(
      'Scope match. Useful baseline for RQ1.',
    )
  })
})

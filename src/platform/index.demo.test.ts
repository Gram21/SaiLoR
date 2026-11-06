import { describe, it, expect, vi } from 'vitest'

vi.mock('../demo/mode', () => ({ DEMO_MODE: true }))

// [utest->req~plt-444~1]
// [utest->req~plt-445~1]
describe('getPlatform in the demo build', () => {
  it('returns the demo adapter, once, for the whole visit', async () => {
    const { getPlatform } = await import('./index')
    const platform = getPlatform()
    expect(platform.kind).toBe('browser')
    expect(platform.getGit()).toBeNull()
    expect(getPlatform()).toBe(platform)
    expect(await platform.checkForNativeUpdate()).toEqual({ supported: false })
  })
})

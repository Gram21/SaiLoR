import { describe, it, expect, afterEach, vi } from 'vitest'
import { copyText } from './clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('resolves true via the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    document.execCommand = vi.fn().mockReturnValue(true)
    const before = document.querySelectorAll('textarea').length

    await expect(copyText('fallback text')).resolves.toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelectorAll('textarea').length).toBe(before)
  })

  it('resolves false when both the Clipboard API and execCommand fail', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    document.execCommand = vi.fn().mockReturnValue(false)

    await expect(copyText('nope')).resolves.toBe(false)
  })
})

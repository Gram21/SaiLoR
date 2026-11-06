import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLanguage } from '../state/settings'

vi.mock('./mode', () => ({ DEMO_MODE: true }))

// [utest->req~plt-450~1]
describe('demo language', () => {
  let stored: Map<string, string>
  beforeEach(() => {
    stored = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    })
    Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true })
  })

  it('opens in English whatever the browser language', () => {
    expect(loadLanguage()).toBe('en')
  })

  it('keeps the language the visitor chose', () => {
    stored.set('slr.language', 'de')
    expect(loadLanguage()).toBe('de')
  })
})

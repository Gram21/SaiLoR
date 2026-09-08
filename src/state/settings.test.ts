import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadTheme,
  applyTheme,
  loadFontScale,
  applyFontScale,
  clampFont,
  loadPaneWidths,
  savePaneWidths,
  loadAutosaveEnabled,
  saveAutosaveEnabled,
  FONT_MIN,
  FONT_MAX,
  PANE_LEFT_DEFAULT,
  PANE_RIGHT_DEFAULT,
  PANE_LEFT_MIN,
  PANE_LEFT_MAX,
  PANE_RIGHT_MIN,
  PANE_RIGHT_MAX,
} from './settings'

/**
 * Appearance settings (theme, font scale, pane widths, autosave) persist
 * across restarts via localStorage. This pins the round-trip and the defaults
 * used when nothing (or something unusable) is stored.
 *
 * jsdom's `localStorage` is disabled for the "about:blank" origin this test
 * environment runs under (no `environmentOptions.jsdom.url` is configured), so
 * a minimal in-memory stand-in is installed here — the exact scenario
 * `safeGet`/`safeSet`'s try/catch in settings.ts exists for ("private mode /
 * disabled storage"), which this incidentally also exercises for real.
 */

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() {
    return this.store.size
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.store.set(key, value)
  }
  removeItem(key: string) {
    this.store.delete(key)
  }
  clear() {
    this.store.clear()
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
})

describe('theme', () => {
  it('defaults to light with nothing stored and no OS preference', () => {
    expect(loadTheme()).toBe('light')
  })

  it('round-trips a saved theme', () => {
    applyTheme('dark')
    expect(loadTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('ignores a stored value that is not a known theme', () => {
    localStorage.setItem('slr.theme', 'blue')
    expect(loadTheme()).toBe('light')
  })
})

describe('font scale', () => {
  it('defaults to 1 with nothing stored', () => {
    expect(loadFontScale()).toBe(1)
  })

  it('round-trips a saved scale', () => {
    applyFontScale(1.3)
    expect(loadFontScale()).toBe(1.3)
    expect(document.documentElement.style.getPropertyValue('--app-font-scale')).toBe('1.3')
  })

  it('clamps to [FONT_MIN, FONT_MAX] and rounds to one decimal', () => {
    expect(clampFont(0.1)).toBe(FONT_MIN)
    expect(clampFont(10)).toBe(FONT_MAX)
    expect(clampFont(1.234)).toBe(1.2)
  })

  it('falls back to 1 for a stored value that is not a usable number', () => {
    localStorage.setItem('slr.fontScale', 'not a number')
    expect(loadFontScale()).toBe(1)
    localStorage.setItem('slr.fontScale', '0')
    expect(loadFontScale()).toBe(1)
    localStorage.setItem('slr.fontScale', '-5')
    expect(loadFontScale()).toBe(1)
  })
})

describe('pane widths', () => {
  it('defaults to the documented widths with nothing stored', () => {
    expect(loadPaneWidths()).toEqual({ left: PANE_LEFT_DEFAULT, right: PANE_RIGHT_DEFAULT })
  })

  it('round-trips saved widths, rounded to whole pixels', () => {
    savePaneWidths({ left: 300.6, right: 400.2 })
    expect(loadPaneWidths()).toEqual({ left: 301, right: 400 })
  })

  it('clamps stored widths back into their min/max range', () => {
    savePaneWidths({ left: PANE_LEFT_MIN - 100, right: PANE_RIGHT_MAX + 100 })
    expect(loadPaneWidths()).toEqual({ left: PANE_LEFT_MIN, right: PANE_RIGHT_MAX })
  })
})

describe('autosave', () => {
  it('defaults to off with nothing stored', () => {
    expect(loadAutosaveEnabled()).toBe(false)
  })

  it('round-trips an explicit choice', () => {
    saveAutosaveEnabled(true)
    expect(loadAutosaveEnabled()).toBe(true)
    saveAutosaveEnabled(false)
    expect(loadAutosaveEnabled()).toBe(false)
  })
})

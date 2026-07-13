/**
 * App appearance settings (theme + font scaling), persisted to localStorage and
 * applied to the document root. These affect the app chrome only — the PDF is
 * rendered on its own white "paper" background regardless of theme.
 */

export type Theme = 'light' | 'dark'

const THEME_KEY = 'slr.theme'
const FONT_KEY = 'slr.fontScale'

export const FONT_MIN = 0.7
export const FONT_MAX = 2.0
export const FONT_STEP = 0.1

/** Resolve the initial theme: stored choice, else the OS preference, else light. */
export function loadTheme(): Theme {
  const stored = safeGet(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

/** Resolve the initial font scale (clamped), defaulting to 1. */
export function loadFontScale(): number {
  const stored = Number(safeGet(FONT_KEY))
  if (Number.isFinite(stored)) return clampFont(stored)
  return 1
}

/** Apply the theme to <html data-theme> and persist it. */
export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme
  safeSet(THEME_KEY, theme)
}

/** Apply the font scale via a CSS variable on <html> and persist it. */
export function applyFontScale(scale: number): void {
  const s = clampFont(scale)
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--app-font-scale', String(s))
  }
  safeSet(FONT_KEY, String(s))
}

/** Clamp to [FONT_MIN, FONT_MAX], rounded to one decimal. */
export function clampFont(scale: number): number {
  const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, scale))
  return Math.round(clamped * 10) / 10
}

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage?.setItem(key, value)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

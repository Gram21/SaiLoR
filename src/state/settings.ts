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

// Resizable pane widths (px).
const LEFT_KEY = 'slr.pane.left'
const RIGHT_KEY = 'slr.pane.right'
export const PANE_LEFT_DEFAULT = 260
export const PANE_RIGHT_DEFAULT = 380
export const PANE_LEFT_MIN = 160
export const PANE_LEFT_MAX = 520
export const PANE_RIGHT_MIN = 260
export const PANE_RIGHT_MAX = 680

export interface PaneWidths {
  left: number
  right: number
}

export function loadPaneWidths(): PaneWidths {
  return {
    left: readNum(LEFT_KEY, PANE_LEFT_DEFAULT, PANE_LEFT_MIN, PANE_LEFT_MAX),
    right: readNum(RIGHT_KEY, PANE_RIGHT_DEFAULT, PANE_RIGHT_MIN, PANE_RIGHT_MAX),
  }
}

export function savePaneWidths(w: PaneWidths): void {
  safeSet(LEFT_KEY, String(Math.round(w.left)))
  safeSet(RIGHT_KEY, String(Math.round(w.right)))
}

function readNum(key: string, dflt: number, min: number, max: number): number {
  const raw = safeGet(key)
  if (raw === null || raw.trim() === '') return dflt
  const n = Number(raw)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/** Resolve the initial theme: stored choice, else the OS preference, else light. */
export function loadTheme(): Theme {
  const stored = safeGet(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

/** Resolve the initial font scale (clamped), defaulting to 1 (= 14px base). */
export function loadFontScale(): number {
  const raw = safeGet(FONT_KEY)
  // Note: Number(null) === 0, so an absent value must be handled explicitly,
  // otherwise it would clamp to FONT_MIN instead of the intended default of 1.
  if (raw === null || raw.trim() === '') return 1
  const stored = Number(raw)
  if (Number.isFinite(stored) && stored > 0) return clampFont(stored)
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

/** Exported so other stores that persist small bits of session state (e.g.
 *  the reviewer selection in `store.ts`) don't each reimplement the same
 *  try/catch — private browsing / disabled storage must never throw. */
export function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage?.setItem(key, value)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage?.removeItem(key)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

import type { LlmConfig } from './types'

/**
 * Input limits of the System One model families, as verified from each
 * project's docs. User-set `contextTokens` / `optionsBudgetTokens` on the
 * config always win over a profile.
 */
export interface SystemOneProfile {
  /** Tokens the server accepts for state + question text combined. */
  contextTokens: number
  /** Per-question budget for instruction + answer options. Absent: see `optionsBudgetOf`. */
  optionsBudgetTokens?: number
  maxQuestions: number
  maxOptionsPerChoice: number
  /** Supported number of score levels (we never ask score questions; recorded for completeness). */
  scoreLevels: [number, number]
  /**
   * The server clips or rejects an over-long head instead of failing cleanly,
   * and reserves a fixed head slot (Laya: state = max_len - head - 1).
   */
  truncatesOverflow: boolean
}

const BIG = { maxOptionsPerChoice: 255, scoreLevels: [2, 10] as [number, number] }

const PROFILES = {
  // Jev: 64k combined; 32k is the budget for state + longest question.
  jev: { contextTokens: 32_000, maxQuestions: 16, truncatesOverflow: false, ...BIG },
  clefHosted: { contextTokens: 65_536, maxQuestions: 64, truncatesOverflow: false, ...BIG },
  clefLocal: { contextTokens: 16_384, maxQuestions: 64, truncatesOverflow: false, ...BIG },
  // ponytail: laya maxQuestions/maxOptions are conservative guesses (~20 short options practical).
  layaEnglish: { contextTokens: 512, optionsBudgetTokens: 192, maxQuestions: 16, maxOptionsPerChoice: 20, scoreLevels: [2, 10], truncatesOverflow: true },
  layaMultilingual: { contextTokens: 1024, optionsBudgetTokens: 256, maxQuestions: 16, maxOptionsPerChoice: 20, scoreLevels: [2, 10], truncatesOverflow: true },
} satisfies Record<string, SystemOneProfile>

const DEFAULT_UNKNOWN_STATE_TOKENS = 50_000 // the old 200k-char default
const OPTIONS_SHARE = 0.35
const OPTIONS_CAP = 4096

function isLocalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
  } catch {
    return false
  }
}

function baseProfile(cfg: LlmConfig): SystemOneProfile {
  const key = (cfg.managed?.catalogId ?? cfg.model ?? '').toLowerCase()
  if (key.includes('jev')) return PROFILES.jev
  if (key.includes('clef')) {
    const hosted = cfg.systemOneFlavor === 'cloudflare' || (!cfg.managed && !!cfg.baseUrl && !isLocalHost(cfg.baseUrl))
    return hosted ? PROFILES.clefHosted : PROFILES.clefLocal
  }
  // laya-typed-decisions shares the multilingual limits (1024 / head 256).
  if (key.includes('laya')) {
    return key.includes('multi') || key.includes('typed') ? PROFILES.layaMultilingual : PROFILES.layaEnglish
  }
  // Unknown family: conservative; trust the user's numbers when given.
  return {
    contextTokens: cfg.maxStateTokens ? cfg.maxStateTokens + OPTIONS_CAP : DEFAULT_UNKNOWN_STATE_TOKENS + OPTIONS_CAP,
    maxQuestions: 16,
    maxOptionsPerChoice: 255,
    scoreLevels: [2, 10],
    truncatesOverflow: false,
  }
}

export function systemOneProfileFor(cfg: LlmConfig): SystemOneProfile {
  const p = baseProfile(cfg)
  return {
    ...p,
    contextTokens: cfg.contextTokens ?? p.contextTokens,
    ...(cfg.optionsBudgetTokens !== undefined || p.optionsBudgetTokens !== undefined
      ? { optionsBudgetTokens: cfg.optionsBudgetTokens ?? p.optionsBudgetTokens }
      : {}),
  }
}

/** Per-question budget: explicit, else 35% of the context capped at 4096 tokens. */
export function optionsBudgetOf(p: SystemOneProfile): number {
  return p.optionsBudgetTokens ?? Math.min(Math.round(p.contextTokens * OPTIONS_SHARE), OPTIONS_CAP)
}

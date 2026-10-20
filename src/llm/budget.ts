import { splitPages } from './tools'
import type { LlmConfig } from './types'

/** Conservative for scientific text (symbols, numbers, citations); the one place for this heuristic. */
export function estimateTokens(text: string, charsPerToken = 3.2): number {
  return Math.ceil(text.length / charsPerToken)
}

export interface FittedText {
  text: string
  truncated: boolean
  pagesKept: number
  pagesTotal: number
  droppedReferences: boolean
}

// Heading alone on its line, optionally numbered.
const REFERENCES_HEADING = /^[ \t]*(?:\d+[.)]?[ \t]+)?(?:references|bibliography|literaturverzeichnis)[ \t:]*$/im

/**
 * Fits `[page N]`-marked paper text into `budgetTokens`: drops the reference
 * list first, then trailing pages, then cuts inside page 1. Never exceeds the
 * budget.
 */
export function fitPaperText(paperText: string, budgetTokens: number): FittedText {
  const whole = (kept: number, total: number, text: string, truncated: boolean, droppedReferences: boolean): FittedText => ({
    text,
    truncated,
    pagesKept: kept,
    pagesTotal: total,
    droppedReferences,
  })
  const parsed = splitPages(paperText)
  const marked = parsed.length > 0
  const pages = marked ? parsed : [{ page: 1, text: paperText.trim() }]
  const total = pages.length
  if (estimateTokens(paperText) <= budgetTokens) return whole(total, total, paperText, false, false)

  // Drop the reference list: first heading at/after the last third of the text.
  let kept = pages
  let droppedReferences = false
  const sum = pages.reduce((n, p) => n + p.text.length, 0)
  let offset = 0
  for (let i = 0; i < pages.length; i++) {
    const m = REFERENCES_HEADING.exec(pages[i].text)
    if (m && offset + m.index >= (sum * 2) / 3) {
      const head = pages[i].text.slice(0, m.index).trim()
      kept = [...pages.slice(0, i), ...(head ? [{ page: pages[i].page, text: head }] : [])]
      droppedReferences = true
      break
    }
    offset += pages[i].text.length
  }
  if (kept.length === 0) kept = pages.slice(0, 1) // heading on page 1: keep going, the cut below fits it

  const render = (ps: typeof pages) => {
    const omitted = total - ps.length
    const note = omitted > 0 ? `[... ${omitted} pages omitted to fit the model's context ...]` : droppedReferences ? '[... reference list omitted ...]' : ''
    return [...ps.map((p) => (marked ? `[page ${p.page}]\n${p.text}` : p.text)), note].filter(Boolean).join('\n\n')
  }

  let out = render(kept)
  while (kept.length > 1 && estimateTokens(out) > budgetTokens) {
    kept = kept.slice(0, -1)
    out = render(kept)
  }
  // A single page still too long: cut inside it (the note stays), then clamp.
  if (estimateTokens(out) > budgetTokens) {
    const room = Math.max(0, Math.floor(budgetTokens * 3.2) - 100)
    out = render([{ ...kept[0], text: kept[0].text.slice(0, room) }])
    while (estimateTokens(out) > budgetTokens) out = out.slice(0, -1)
  }
  return whole(kept.length, total, out, true, droppedReferences)
}

/**
 * Tokens left for paper text in a chat request: the model's window minus what
 * the prompt already spends. Null when the window is unknown (callers send
 * everything, as before).
 */
export function chatInputBudget(
  cfg: Pick<LlmConfig, 'contextTokens'>,
  r: { systemTokens: number; fewShotTokens?: number; outputReserve?: number; thinkReserve?: number },
): number | null {
  if (!cfg.contextTokens) return null
  const reserved = r.systemTokens + (r.fewShotTokens ?? 0) + (r.outputReserve ?? 4096) + (r.thinkReserve ?? 0)
  return Math.max(0, cfg.contextTokens - reserved)
}

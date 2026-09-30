import { Fragment, useEffect, useState } from 'react'
import {
  useAiStore,
  buildFewShotForPaper,
  fewShotCandidates,
  type AiMode,
  type PaperNotes,
  type PaperSkip,
  type RecheckRow,
  type ReviewRow,
} from '../state/aiStore'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'
import { aiSeatId, seatLabel } from '../model/project'
import { PROVIDERS } from '../llm/providers'
import { displayPath, parsePath, resolvePath } from '../llm/paths'
import { estimateRun, estimateCost, estimateCostSplit, WEB_SEARCH_NOTE, type TokenEstimate } from '../llm/cost'
import { systemOneEligible } from '../llm/systemone'
import type { LlmConfig } from '../llm/types'
import type { FieldValue } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { ComboBox } from './ComboBox'
import { Spinner } from './Spinner'
import '../styles/ai.css'

/**
 * The AI-assisted annotation dialog: a view over `useAiStore`, which owns the
 * whole flow. Nothing here talks to the project — the reviewer ticks the rows
 * they accept and `apply()` writes them in one undo step.
 *
 * The shape of the screen follows the store's `phase`, and the invariant that
 * matters is: **nothing is sent until Start, nothing is written until Apply.**
 */

/** "Findings[1]/Claim" → "Findings #2 › Claim". Falls back to the raw path if unparsable. */
function pathLabel(raw: string): string {
  const segs = parsePath(raw)
  return segs ? displayPath(segs) : raw
}

/** The model's value, as a reviewer reads it — a boolean is a tick, not the word "true". */
function ValueCell({ value }: { value: FieldValue }) {
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'ai-bool yes' : 'ai-bool no'} title={value ? 'Yes' : 'No'}>
        {value ? '✓' : '✗'}
        <span className="ai-sr-only">{value ? 'Yes' : 'No'}</span>
      </span>
    )
  }
  if (value === null || value === '') return <span className="ai-dash">—</span>
  return <>{String(value)}</>
}

/**
 * The control shown while editing a review row's value — one control per
 * field type, matching `Field.tsx`'s per-type choice (checkbox / enum
 * dropdown / number input / free text) without pulling in that component's
 * PDF-linking/marking machinery, which has no meaning for a not-yet-applied
 * proposal. `def` may be missing (the schema changed since the run started);
 * a plain text box is the fallback.
 */
function EditControl({
  def,
  value,
  onChange,
}: {
  def: ResolvedDef | undefined
  value: FieldValue
  onChange: (v: FieldValue) => void
}) {
  if (def?.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        aria-label="Edited value"
      />
    )
  }
  if (def?.type === 'string' && def.options && def.options.length > 0) {
    return (
      <ComboBox
        value={typeof value === 'string' ? value : null}
        options={def.options}
        onChange={(v) => onChange(v)}
        ariaLabel="Edited value"
      />
    )
  }
  if (def?.type === 'number' || def?.type === 'year') {
    return (
      <input
        type="number"
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        aria-label="Edited value"
      />
    )
  }
  return (
    <input
      type="text"
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Edited value"
    />
  )
}

function confidenceLabel(confidence: number | null): string {
  return confidence === null ? '—' : `${Math.round(confidence * 100)}%`
}

/**
 * What actually leaves the machine for this target. Mirrors `run()`: a target set
 * to "send the PDF" against a provider that cannot take one silently falls back to
 * the extracted text, and the consent line must not promise otherwise.
 */
function deliveryOf(cfg: LlmConfig): 'text' | 'pdf' {
  return cfg.attach === 'pdf' && PROVIDERS[cfg.provider].supportsPdf ? 'pdf' : 'text'
}

/** Rough token/request range, plus a cost range when both targets involved
 *  have prices set — see cost.ts. Never blocks Start: called with whatever
 *  page counts are cached so far. */
function estimateLine(
  mode: AiMode,
  selected: LlmConfig,
  judgeCfg: LlmConfig | null,
  pages: number[],
  fields: number,
  fewShotTokens: number,
  webSearch: boolean,
  /** Answered fields per paper when re-check is on (0 = off): one more prompt-style request per paper. */
  recheckFields: number,
): string {
  const input = {
    papers: pages.map((p) => ({ pages: p })),
    mode,
    delivery: deliveryOf(selected),
    fewShotTokens,
  }
  let est = estimateRun({ ...input, fieldsPerPaper: fields, webSearch })
  if (recheckFields > 0) {
    const rc = estimateRun({ ...input, fieldsPerPaper: recheckFields })
    const sum = (a: TokenEstimate['low'], b: TokenEstimate['low']) => ({
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
    })
    est = {
      ...est,
      low: sum(est.low, rc.low),
      high: sum(est.high, rc.high),
      requests: { low: est.requests.low + rc.requests.low, high: est.requests.high + rc.requests.high },
    }
  }
  const cost =
    mode === 'agent' && judgeCfg ? estimateCostSplit(est, selected, judgeCfg) : estimateCost(est, selected)
  const tokens =
    `Estimated: ~${est.low.inputTokens.toLocaleString()}–${est.high.inputTokens.toLocaleString()} input tokens, ` +
    `~${est.low.outputTokens.toLocaleString()}–${est.high.outputTokens.toLocaleString()} output tokens, ` +
    `${est.requests.low}–${est.requests.high} request${est.requests.high === 1 ? '' : 's'}`
  return cost
    ? `${tokens} (≈ $${cost.low.toFixed(2)}–$${cost.high.toFixed(2)}). Rough estimate, not a quote.`
    : `${tokens}. Add prices in AI models settings to see a cost estimate. Rough estimate, not a quote.`
}

const PHASE_LINE: Record<string, string> = {
  reading: 'Reading the PDF…',
  parsing: 'Reading the answer…',
}

const MODE_INFO: Record<AiMode, string> = {
  prompt: 'One request per paper: the model reads the paper once and proposes values.',
  agent:
    'The model searches and re-reads the paper with tools, may look things up on the web ' +
    '(OpenAlex, Crossref, web pages the paper refers to), and a second AI pass (a judge) checks ' +
    'every value — anything it flags is redone, up to 3 rounds. This takes considerably longer ' +
    'and costs considerably more: typically 5–15 model requests per paper instead of one.',
  classify:
    'Fast and very cheap. Only yes/no and single-choice fields; returns a probability per ' +
    'answer but no quotes from the paper — check each value yourself.',
}

/** A model with no price entered yet — shown next to a role picker so a blank
 *  cost estimate has an obvious reason. */
function priceHint(cfg: LlmConfig | null): boolean {
  return !!cfg && (cfg.inputPrice === undefined || cfg.outputPrice === undefined)
}

function modelOption(c: LlmConfig): { id: string; label: string } {
  return { id: c.id, label: `${c.name} — ${PROVIDERS[c.provider].label} · ${c.model}` }
}

/** The consequences warning for turning on "annotate all papers", worded to stay
 *  accurate whichever mode is selected — shown both in the one-time confirmation
 *  and, once confirmed, as a standing reminder under the toggle. */
function allPapersWarning(mode: AiMode, count: number, recheck: boolean): string {
  const perPaper = mode === 'agent' ? 'many requests per paper' : 'one request per paper'
  const time = mode === 'agent' ? 'several minutes per paper' : 'about a minute per paper'
  const cost = mode === 'agent' ? ', several times higher than prompt mode' : ''
  return (
    `This sends ${count} paper${count === 1 ? '' : 's'} — ${perPaper}. Your provider charges ` +
    `your API key for every request, so cost scales with the number of papers${cost}. Rough ` +
    `estimate: ${time}. Every paper's content leaves this machine. ` +
    (recheck
      ? "Re-check is on, so this includes papers you marked finished and adds a second request per paper. "
      : '') +
    'You can cancel at any time and keep whatever has finished so far.'
  )
}

export function AiDialog() {
  const open = useAiStore((s) => s.open)
  const minimized = useAiStore((s) => s.minimized)
  const configs = useAiStore((s) => s.configs)
  const selectedId = useAiStore((s) => s.selectedId)
  const mode = useAiStore((s) => s.mode)
  const allPapers = useAiStore((s) => s.allPapers)
  const candidates = useAiStore((s) => s.candidates)
  const judgeSelectedId = useAiStore((s) => s.judgeSelectedId)
  const crossCheckId = useAiStore((s) => s.crossCheckId)
  const confidenceThreshold = useAiStore((s) => s.confidenceThreshold)
  const spendCap = useAiStore((s) => s.spendCap)
  const spentSoFar = useAiStore((s) => s.spentSoFar)
  const spendCapHit = useAiStore((s) => s.spendCapHit)
  const retryNotice = useAiStore((s) => s.retryNotice)
  const fewShot = useAiStore((s) => s.fewShot)
  const fewShotCount = useAiStore((s) => s.fewShotCount)
  const fewShotAvailable = useAiStore((s) => s.fewShotAvailable)
  const pageCounts = useAiStore((s) => s.pageCounts)
  const pageCountsLoading = useAiStore((s) => s.pageCountsLoading)
  const currentPaperHasPdf = useAiStore((s) => s.currentPaperHasPdf)
  const phase = useAiStore((s) => s.phase)
  const error = useAiStore((s) => s.error)
  const elapsed = useAiStore((s) => s.elapsed)
  const targets = useAiStore((s) => s.targets)
  const rows = useAiStore((s) => s.rows)
  const notes = useAiStore((s) => s.notes)
  const applied = useAiStore((s) => s.applied)
  const scanned = useAiStore((s) => s.scanned)
  const settingsOpen = useAiStore((s) => s.settingsOpen)
  const batchDone = useAiStore((s) => s.batchDone)
  const batchTotal = useAiStore((s) => s.batchTotal)
  const inFlightPapers = useAiStore((s) => s.inFlightPapers)
  const skippedPapers = useAiStore((s) => s.skippedPapers)
  const concurrency = useAiStore((s) => s.concurrency)
  const resumeAvailable = useAiStore((s) => s.resumeAvailable)
  const agentEvents = useAiStore((s) => s.agentEvents)
  const runErrors = useAiStore((s) => s.errors)
  const usage = useAiStore((s) => s.usage)
  const recheck = useAiStore((s) => s.recheck)
  const answeredCount = useAiStore((s) => s.answeredCount)
  const webSearch = useAiStore((s) => s.webSearch)
  const saveFeedback = useAiStore((s) => s.saveFeedback)
  const feedbackResult = useAiStore((s) => s.feedbackResult)
  const recheckRows = useAiStore((s) => s.recheckRows)
  const webSearchesByPaper = useAiStore((s) => s.webSearchesByPaper)

  const closeDialog = useAiStore((s) => s.closeDialog)
  const setMinimized = useAiStore((s) => s.setMinimized)
  const setSettingsOpen = useAiStore((s) => s.setSettingsOpen)
  const selectConfig = useAiStore((s) => s.selectConfig)
  const setMode = useAiStore((s) => s.setMode)
  const setAllPapers = useAiStore((s) => s.setAllPapers)
  const selectJudge = useAiStore((s) => s.selectJudge)
  const selectCrossCheck = useAiStore((s) => s.selectCrossCheck)
  const setConfidenceThreshold = useAiStore((s) => s.setConfidenceThreshold)
  const setSpendCap = useAiStore((s) => s.setSpendCap)
  const setFewShot = useAiStore((s) => s.setFewShot)
  const setFewShotCount = useAiStore((s) => s.setFewShotCount)
  const setRecheck = useAiStore((s) => s.setRecheck)
  const setWebSearch = useAiStore((s) => s.setWebSearch)
  const setSaveFeedback = useAiStore((s) => s.setSaveFeedback)
  const toggleRecheckRow = useAiStore((s) => s.toggleRecheckRow)
  const ensurePageCounts = useAiStore((s) => s.ensurePageCounts)
  const run = useAiStore((s) => s.run)
  const resumeBatch = useAiStore((s) => s.resumeBatch)
  const setConcurrency = useAiStore((s) => s.setConcurrency)
  const discardBatch = useAiStore((s) => s.discardBatch)
  const dismissResume = useAiStore((s) => s.dismissResume)
  const cancel = useAiStore((s) => s.cancel)
  const skipPaper = useAiStore((s) => s.skipPaper)
  const toggleRow = useAiStore((s) => s.toggleRow)
  const setAllRows = useAiStore((s) => s.setAllRows)
  const editRow = useAiStore((s) => s.editRow)
  const apply = useAiStore((s) => s.apply)

  const project = useStore((s) => s.project)
  const currentPaper = useStore((s) => s.project?.papers.find((p) => p.id === s.currentPaperId))
  const currentPaperId = useStore((s) => s.currentPaperId)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectPaper = useStore((s) => s.selectPaper)
  const requestPdfFind = useStore((s) => s.requestPdfFind)
  const saveHandle = useStore((s) => s.saveHandle)

  /** Clicking a paper-sourced evidence quote: switch to that paper if needed,
   *  ask `PdfViewer` to find+highlight it, and peek at the PDF (see `minimized`). */
  const jumpToEvidence = (paperId: string, quote: string) => {
    if (paperId !== currentPaperId) selectPaper(paperId)
    requestPdfFind(paperId, quote)
    setMinimized(true)
  }

  // The one-time consequences warning is local UI state: it is shown between
  // ticking the toggle and confirming, and never persisted.
  const [pendingAllPapers, setPendingAllPapers] = useState(false)

  // "Show only rows that need attention" — local UI state, reset per run like
  // the review table itself would be (never persisted, never sent anywhere).
  const [attentionOnly, setAttentionOnly] = useState(false)
  useEffect(() => {
    if (phase !== 'review') setAttentionOnly(false)
  }, [phase])

  useEffect(() => {
    if (phase !== 'setup') setPendingAllPapers(false)
  }, [phase])

  // The cost estimate's page counts, fetched lazily and cached by the store —
  // recomputed whenever the scope (single paper vs. all papers, or which
  // papers) changes. Never blocks Start: the estimate just says "Estimating…"
  // until these land.
  const scopePaperIds = allPapers ? candidates.map((c) => c.id) : currentPaper ? [currentPaper.id] : []
  useEffect(() => {
    if (!open || phase !== 'setup' || scopePaperIds.length === 0) return
    void ensurePageCounts(scopePaperIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, allPapers, currentPaper?.id, candidates])

  useEffect(() => {
    if (!open || settingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, settingsOpen, closeDialog])

  if (!open) return null

  if (minimized) {
    return (
      <button
        type="button"
        className="ai-peek-back"
        onClick={() => setMinimized(false)}
        title="Reopen the AI review table"
      >
        ← Back to AI review
      </button>
    )
  }

  const selected = configs.find((c) => c.id === selectedId) ?? null
  // The judge target actually in play: null both means "not agent mode" and
  // "same as agent" — `judgeSelectedId` is the only thing that distinguishes
  // those, and callers that care (the consent line, the estimate) already
  // have `mode` to tell them apart.
  const judgeCfg = judgeSelectedId ? configs.find((c) => c.id === judgeSelectedId) ?? null : null
  const crossCheckCfg = crossCheckId ? configs.find((c) => c.id === crossCheckId) ?? null : null
  const systemOneConfigs = configs.filter((c) => c.provider === 'systemone')
  const chatConfigs = configs.filter((c) => c.provider !== 'systemone')
  const annotatorConfigs = mode === 'classify' ? systemOneConfigs : chatConfigs
  const checkedCount = rows.filter((r) => r.checked).length
  // "Needs attention": still unticked, or flagged when it started that way
  // and the reviewer re-ticked it (REQ-LLM-580) — feeds both the header note
  // and the attention-only filter.
  const attentionRows = rows.filter((r) => r.flagged || !r.checked)
  const running = phase === 'reading' || phase === 'calling' || phase === 'parsing'
  const canStartSingle =
    !!currentPaper && currentPaperHasPdf && (targets.length > 0 || (recheck && answeredCount > 0))
  const webSearchSupported = !!selected && PROVIDERS[selected.provider].supportsWebSearch
  const webSearchOn = mode === 'agent' && webSearch && webSearchSupported
  const feedbackPossible = getPlatform().kind === 'electron' && !!saveHandle?.path
  const tickedReplacements = recheckRows.filter((r) => r.outcome.verdict === 'disagree' && r.checked).length
  const applyCount = checkedCount + tickedReplacements
  const totalWebSearches = Object.values(webSearchesByPaper).reduce((n, c) => n + c, 0)
  const canStartAll = candidates.length > 0
  const canStart = allPapers ? canStartAll : canStartSingle

  // Representative estimate only (the current paper's block, like `targets`
  // above) — every paper in all-papers mode gets its own, similarly sized one.
  const fewShotBlock =
    fewShot && project && currentPaperId
      ? buildFewShotForPaper(project.schema, fewShotCandidates(project, currentReviewer), fewShotCount, currentPaperId)
      : null
  const fewShotTokens = fewShotBlock ? Math.ceil(fewShotBlock.block.length / 4) : 0

  const pagesKnown = scopePaperIds.length > 0 && scopePaperIds.every((id) => pageCounts[id] !== undefined)
  const estimateText = !selected
    ? null
    : pagesKnown
      ? estimateLine(
          mode,
          selected,
          judgeCfg,
          scopePaperIds.map((id) => pageCounts[id]),
          targets.length,
          fewShotTokens,
          webSearchOn,
          recheck ? answeredCount : 0,
        )
      : scopePaperIds.some((id) => pageCountsLoading[id])
        ? 'Estimating…'
        : null
  // Both targets priced — costs can be split accurately; the cap only makes
  // sense once it can be compared to something.
  const capKnown =
    !!selected &&
    selected.inputPrice !== undefined &&
    selected.outputPrice !== undefined &&
    // Only agent mode prices a second (judge) target — classify has none,
    // and cross-check is optional, so neither blocks the cap on its price.
    (mode !== 'agent' ||
      ((judgeCfg ?? selected).inputPrice !== undefined && (judgeCfg ?? selected).outputPrice !== undefined))

  // Grouped only when more than one paper is actually in the review set.
  const paperOrder: string[] = []
  for (const r of rows) if (!paperOrder.includes(r.paperId)) paperOrder.push(r.paperId)
  const grouped = paperOrder.length > 1

  const aiSeat = project ? aiSeatId(project) : null

  const gearButton = (
    <button
      type="button"
      className="icon-btn"
      onClick={() => setSettingsOpen(true)}
      title="AI models"
      aria-label="AI models"
    >
      ⚙
    </button>
  )

  function onToggleAllPapers(checked: boolean) {
    if (checked) setPendingAllPapers(true)
    else {
      setAllPapers(false)
      setPendingAllPapers(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={() => closeDialog()}>
      <div
        className="modal ai-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Annotate with AI"
      >
        <div className="modal-head">
          <strong>Annotate with AI</strong>
          <button
            type="button"
            className="icon-btn"
            onClick={() => closeDialog()}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          {phase === 'setup' && (
            <>
              {resumeAvailable && (
                <div className="ai-confirm">
                  <p className="ai-note">
                    An all-papers run stopped after {resumeAvailable.doneIds.length} of{' '}
                    {resumeAvailable.allPaperIds.length} papers (
                    {new Date(resumeAvailable.startedAt).toLocaleString()}).
                  </p>
                  <div className="ai-foot">
                    <button
                      type="button"
                      onClick={() => dismissResume()}
                      title="Discard the saved progress and start over"
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void resumeBatch()}
                      title="Continue the saved run where it left off"
                    >
                      Resume
                    </button>
                  </div>
                </div>
              )}

              {configs.length === 0 && (
                <div className="ai-empty-configs">
                  <p>No AI model is set up yet.</p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setSettingsOpen(true)}
                    title="Open AI models settings to add one"
                  >
                    Set up a model…
                  </button>
                </div>
              )}

              {/* What: scope (current paper vs. all papers) and which fields will be asked. */}
              <div className="ai-label" id="ai-what-label">
                What
              </div>
              <p className="ai-scope">
                {allPapers ? (
                  <>
                    Annotating <strong>{candidates.length} paper{candidates.length === 1 ? '' : 's'}</strong>.
                  </>
                ) : (
                  <>
                    Annotating the current paper only: <strong>{currentPaper?.title ?? '—'}</strong>
                  </>
                )}
              </p>
              {!allPapers && currentPaper && !currentPaperHasPdf && (
                <p className="ai-note">This paper has no PDF — there is nothing to send.</p>
              )}

              <label className="ai-toggle-row">
                <input
                  type="checkbox"
                  checked={allPapers}
                  onChange={(e) => onToggleAllPapers(e.target.checked)}
                />
                Annotate all papers
              </label>

              {pendingAllPapers && !allPapers && (
                <div className="ai-confirm">
                  <p className="ai-note">{allPapersWarning(mode, candidates.length, recheck)}</p>
                  <div className="ai-foot">
                    <button type="button" onClick={() => setPendingAllPapers(false)} title="Keep annotating only the current paper">
                      Current paper only
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setAllPapers(true)
                        setPendingAllPapers(false)
                      }}
                      disabled={candidates.length === 0}
                      title="Turn on all-papers annotation"
                    >
                      Annotate all {candidates.length} papers
                    </button>
                  </div>
                </div>
              )}
              {allPapers && <p className="ai-note">{allPapersWarning(mode, candidates.length, recheck)}</p>}

              <p className="ai-targets">
                {targets.length === 0
                  ? recheck && answeredCount > 0
                    ? 'Every field of this paper is already filled in — only the re-check will run.'
                    : 'Every field of this paper is already filled in — there is nothing to propose.'
                  : `${targets.length} empty field${targets.length === 1 ? '' : 's'} will be proposed.`}
              </p>

              {targets.length > 0 && (
                <details className="ai-prompt">
                  <summary>Which fields will the AI fill in? ({targets.length})</summary>
                  <p className="ai-note">
                    Only these empty fields are sent to the AI; fields that already have a value
                    are never touched.
                    {allPapers &&
                      ' In all-papers mode, each paper is asked only about its own empty fields — this is just the current paper’s list, as an example.'}
                  </p>
                  <ul className="ai-field-list">
                    {targets.map((t) => (
                      <li key={t.path}>
                        <span className="ai-field-path">{pathLabel(t.path)}</span>
                        <span className="ai-field-type">{t.def.type}</span>
                        {t.def.options && t.def.options.length > 0 && (
                          <span className="ai-field-options">
                            one of: {t.def.options.join(' · ')}
                          </span>
                        )}
                        {mode === 'classify' && !systemOneEligible(t) && (
                          <span className="ai-note-reason">not handled in Classify mode</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* How: prompt / agent / classify. */}
              <div className="ai-label" id="ai-mode-label">
                How
              </div>
              <div className="ai-mode-row" role="radiogroup" aria-labelledby="ai-mode-label">
                <label>
                  <input
                    type="radio"
                    name="ai-mode"
                    checked={mode === 'prompt'}
                    onChange={() => setMode('prompt')}
                  />
                  Prompt
                </label>
                <label>
                  <input
                    type="radio"
                    name="ai-mode"
                    checked={mode === 'agent'}
                    onChange={() => setMode('agent')}
                  />
                  Agent
                </label>
                <label
                  title={
                    systemOneConfigs.length === 0
                      ? 'Add a System One model in AI models settings to enable Classify mode.'
                      : undefined
                  }
                >
                  <input
                    type="radio"
                    name="ai-mode"
                    checked={mode === 'classify'}
                    disabled={systemOneConfigs.length === 0}
                    onChange={() => setMode('classify')}
                  />
                  Classify
                </label>
              </div>
              <p className="ai-note">{MODE_INFO[mode]}</p>

              {/* Models: assign a library model to each role. */}
              <div className="ai-label" id="ai-models-label">
                Models
              </div>

              <div className="ai-label" id="ai-annotator-label">
                Annotator
              </div>
              <div className="ai-target-row" role="group" aria-labelledby="ai-annotator-label">
                <ComboBox
                  value={selectedId}
                  options={annotatorConfigs.map(modelOption)}
                  onChange={(id) => {
                    if (id) selectConfig(id)
                  }}
                />
                {gearButton}
              </div>
              {priceHint(selected) && <p className="ai-note">no price set</p>}

              {mode === 'agent' && (
                <>
                  <div className="ai-label" id="ai-judge-label">
                    Judge
                  </div>
                  <div className="ai-target-row" role="group" aria-labelledby="ai-judge-label">
                    <ComboBox
                      value={judgeSelectedId ?? ''}
                      options={[
                        {
                          id: '',
                          label: `Same as annotator${selected ? ` (${selected.name})` : ''}`,
                        },
                        ...chatConfigs.map(modelOption),
                      ]}
                      onChange={(id) => selectJudge(id || null)}
                    />
                  </div>
                  <p className="ai-note">
                    A different model — ideally a different provider or family — catches mistakes the
                    annotator's own model is prone to repeat when it reviews itself. A cheaper model
                    here keeps judge costs down.
                  </p>
                  {priceHint(judgeCfg) && <p className="ai-note">no price set</p>}
                </>
              )}

              {mode !== 'classify' && systemOneConfigs.length > 0 && (
                <>
                  <div className="ai-label" id="ai-crosscheck-label">
                    Cross-check (optional)
                  </div>
                  <div className="ai-target-row" role="group" aria-labelledby="ai-crosscheck-label">
                    <ComboBox
                      value={crossCheckId ?? ''}
                      options={[{ id: '', label: 'None' }, ...systemOneConfigs.map(modelOption)]}
                      onChange={(id) => selectCrossCheck(id || null)}
                    />
                  </div>
                  <p className="ai-note">
                    Asks this System One model the same yes/no or single-choice fields
                    independently and flags disagreements for review.
                  </p>
                  {priceHint(crossCheckCfg) && <p className="ai-note">no price set</p>}
                </>
              )}

              {aiSeat && project && (
                <p className="ai-note">
                  Answers go into the AI's own seat: <strong>{seatLabel(project, aiSeat)}</strong>.
                </p>
              )}

              <p className="ai-consent">
                {selected ? (
                  <>
                    {mode === 'classify'
                      ? `The title, abstract and extracted text of ${allPapers ? 'each paper' : 'this paper'} (truncated to fit) will be sent to `
                      : deliveryOf(selected) === 'pdf'
                        ? `This paper${allPapers ? "'s" : '’s'} PDF file will be sent to `
                        : `The text of ${allPapers ? 'each paper' : 'this paper'} will be extracted and sent to `}
                    <strong>{PROVIDERS[selected.provider].label}</strong> ({selected.model}). It
                    leaves this machine. Nothing is written into the project until you press Apply.
                    {mode === 'agent' &&
                      ' Agent mode may also send search terms or URLs chosen by the model to OpenAlex, Crossref, or other sites; these can contain short phrases from the paper, but never the paper file itself.'}
                    {mode === 'agent' &&
                      judgeCfg &&
                      judgeCfg.provider !== selected.provider &&
                      ` The judge's review is sent to ${PROVIDERS[judgeCfg.provider].label} (${judgeCfg.model}) as well — it also sees the paper.`}
                    {webSearchOn &&
                      ` Search queries chosen by the model are handled by ${PROVIDERS[selected.provider].label}.`}
                    {mode !== 'classify' &&
                      crossCheckCfg &&
                      ` The cross-check fields are sent to ${PROVIDERS[crossCheckCfg.provider].label} (${crossCheckCfg.model}) as well.`}
                    {mode !== 'classify' &&
                      fewShot &&
                      fewShotAvailable > 0 &&
                      ` …plus the annotations (and abstracts) of ${Math.min(fewShotCount, fewShotAvailable)} of your finished papers as examples.`}
                  </>
                ) : (
                  'Nothing is sent until you choose an annotator model and press Start.'
                )}
              </p>

              {estimateText && <p className="ai-note ai-estimate">{estimateText}</p>}

              {/* Options: everything a run doesn't strictly need to choose. */}
              <details className="ai-prompt">
                <summary>Options</summary>

                {mode !== 'classify' && (
                  <>
                    <label className="ai-toggle-row">
                      <input
                        type="checkbox"
                        checked={fewShot}
                        disabled={fewShotAvailable === 0}
                        onChange={(e) => setFewShot(e.target.checked)}
                      />
                      Show the AI my finished papers as examples
                    </label>
                    <p className="ai-note">
                      {fewShotAvailable === 0
                        ? 'No finished papers are available yet as examples.'
                        : `${fewShotAvailable} finished paper${fewShotAvailable === 1 ? '' : 's'} available.`}
                    </p>
                    {fewShot && fewShotAvailable > 0 && (
                      <div className="ai-target-row">
                        <label htmlFor="ai-fewshot-count">Show up to</label>
                        <select
                          id="ai-fewshot-count"
                          value={fewShotCount}
                          onChange={(e) => setFewShotCount(Number(e.target.value))}
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </>
                )}

                <label className="ai-toggle-row">
                  <input
                    type="checkbox"
                    checked={recheck}
                    disabled={mode !== 'prompt'}
                    onChange={(e) => setRecheck(e.target.checked)}
                  />
                  Also re-check fields I've already filled
                </label>
                <p className="ai-note">
                  The AI double-checks values already entered in this seat and flags likely mistakes.
                  Nothing is changed unless you tick a proposed replacement.
                  {mode !== 'prompt' && ' Available in Prompt mode only.'}
                </p>

                {mode === 'agent' && (
                  <>
                    <label className="ai-toggle-row">
                      <input
                        type="checkbox"
                        checked={webSearchOn}
                        disabled={!webSearchSupported}
                        onChange={(e) => setWebSearch(e.target.checked)}
                      />
                      Let the model search the web
                    </label>
                    <p className="ai-note">
                      {webSearchSupported
                        ? WEB_SEARCH_NOTE
                        : "The selected model's provider has no built-in web search (supported: Anthropic, OpenRouter)"}
                    </p>
                  </>
                )}

                <label className="ai-toggle-row">
                  <input
                    type="checkbox"
                    checked={saveFeedback && feedbackPossible}
                    disabled={!feedbackPossible}
                    onChange={(e) => setSaveFeedback(e.target.checked)}
                  />
                  Save feedback about the annotation schema
                </label>
                <p className="ai-note">
                  Saves which fields the AI left empty, got flagged or that you corrected, plus the
                  model's remarks on unclear field descriptions, to annotations/feedback/ in the
                  project folder (field values only, no paper text) — useful for improving the schema.
                  {!feedbackPossible &&
                    (getPlatform().kind === 'electron' ? ' Save the project first.' : ' Desktop app only.')}
                </p>

                {allPapers && (
                  <div className="ai-target-row">
                    <label htmlFor="ai-concurrency">Papers at once</label>
                    <select
                      id="ai-concurrency"
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                      title="More at once is faster, but hits your provider's rate limits sooner — retries back off automatically."
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {allPapers && (
                  <div className="ai-target-row">
                    <label htmlFor="ai-spend-cap">Stop when spent exceeds $</label>
                    <input
                      id="ai-spend-cap"
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={!capKnown}
                      value={spendCap ?? ''}
                      onChange={(e) => setSpendCap(e.target.value === '' ? null : Number(e.target.value))}
                      placeholder={capKnown ? 'no limit' : 'set prices to enable'}
                      title={
                        capKnown
                          ? 'Stop starting new papers once the running cost estimate passes this amount.'
                          : 'Add prices to the model(s) in AI models settings to enable a spending cap.'
                      }
                    />
                  </div>
                )}

                {(mode === 'classify' || crossCheckCfg) && (
                  <div className="ai-target-row">
                    <label htmlFor="ai-threshold">Unticked below confidence</label>
                    <input
                      id="ai-threshold"
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={confidenceThreshold}
                      onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
                      title={
                        mode === 'classify'
                          ? 'A classify-mode row below this probability starts unticked.'
                          : 'A cross-check disagreement at or above this probability starts the row unticked.'
                      }
                    />
                  </div>
                )}
              </details>

              <div className="ai-foot">
                <button type="button" onClick={() => closeDialog()} title="Cancel without sending anything">
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void run()}
                  disabled={!selected || !canStart}
                  title="Send the paper(s) to the selected AI model"
                >
                  Start
                </button>
              </div>
            </>
          )}

          {running && (
            <>
              <div className="ai-running" role="status">
                <Spinner />
                <span className="ai-phase">
                  {phase === 'calling'
                    ? `Waiting for ${selected?.model ?? 'the model'}…`
                    : PHASE_LINE[phase]}
                </span>
                <span className="ai-elapsed">{elapsed}s</span>
              </div>
              {batchTotal > 1 && (
                <>
                  <p className="ai-note">
                    {batchDone} of {batchTotal} papers done
                    {capKnown && ` · $${spentSoFar.toFixed(2)} spent so far`}
                  </p>
                  {inFlightPapers.length > 0 && (
                    <ul className="ai-note-list ai-inflight-list">
                      {inFlightPapers.map((p) => (
                        <li key={p.id}>
                          {p.title}
                          <button
                            type="button"
                            onClick={() => skipPaper(p.id)}
                            title="Skip this paper only — the rest of the batch keeps going, and this one stays eligible to run later"
                          >
                            Skip
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {retryNotice && <p className="ai-note ai-retry">{retryNotice}</p>}
              {mode === 'agent' && agentEvents.length > 0 && (
                <ul className="ai-note-list ai-agent-events">
                  {agentEvents.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
              <p className="ai-note">
                This can take a while, especially in agent mode or with many papers. You can
                cancel at any time.
              </p>
              <div className="ai-foot">
                <button type="button" onClick={() => cancel()} title="Cancel the request in progress">
                  Cancel
                </button>
              </div>
            </>
          )}

          {phase === 'review' && (
            <>
              {allPapers && batchTotal > 0 && batchDone < batchTotal && (
                <p className="ai-note">
                  <button
                    type="button"
                    onClick={() => void resumeBatch()}
                    title="Continue this run — the papers already done are kept"
                  >
                    Continue with the remaining {batchTotal - batchDone} paper
                    {batchTotal - batchDone === 1 ? '' : 's'}
                  </button>
                </p>
              )}

              <SkippedPapers papers={skippedPapers} />

              {rows.length === 0 && recheckRows.length === 0 ? (
                <>
                  <p>The model proposed no values.</p>
                  <RunErrors errors={runErrors} />
                  {notes.map((n) => (
                    <ReviewNotes key={n.paperId} notes={n} />
                  ))}
                  <div className="ai-foot">
                    <button type="button" className="primary" onClick={() => closeDialog()} title="Close this dialog">
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {rows.length > 0 && (
                    <>
                      <div className="ai-review-head">
                        <div className="ai-select-all">
                          <button type="button" onClick={() => setAllRows(true)} title="Select all proposed rows">
                            Select all
                          </button>
                          <button type="button" onClick={() => setAllRows(false)} title="Deselect all proposed rows">
                            Select none
                          </button>
                        </div>
                        <span className="ai-count">
                          {checkedCount} of {rows.length} selected
                        </span>
                      </div>

                      <RunErrors errors={runErrors} />

                      {spendCapHit && (
                        <p className="ai-note ai-cap-hit">
                          Stopped at the spending limit (${spentSoFar.toFixed(2)} spent).
                        </p>
                      )}

                      {attentionRows.length > 0 && (
                        <p className="ai-note">
                          {attentionRows.length} row{attentionRows.length === 1 ? '' : 's'} start
                          {attentionRows.length === 1 ? 's' : ''} unticked: low confidence, flagged by
                          the judge, the cross-check disagrees, or the value came from a web search
                          whose quote is unchecked.
                        </p>
                      )}
                      <label className="ai-toggle-row">
                        <input
                          type="checkbox"
                          checked={attentionOnly}
                          disabled={attentionRows.length === 0}
                          onChange={(e) => setAttentionOnly(e.target.checked)}
                        />
                        Show only rows that need attention
                      </label>

                      <ReviewTable
                        rows={rows}
                        grouped={grouped}
                        mode={mode}
                        schema={project?.schema ?? []}
                        attentionOnly={attentionOnly}
                        onToggle={toggleRow}
                        onEvidenceClick={(row) => jumpToEvidence(row.paperId, row.suggestion.evidence)}
                        onEdit={editRow}
                      />
                    </>
                  )}

                  <RunErrors errors={rows.length === 0 ? runErrors : []} />
                  <RecheckSection
                    rows={recheckRows}
                    onToggle={toggleRecheckRow}
                    onEvidenceClick={(row) => jumpToEvidence(row.paperId, row.outcome.evidence)}
                  />

                  {notes.map((n) => (
                    <ReviewNotes key={n.paperId} notes={n} />
                  ))}

                  {(usage.calls > 0 || usage.inputTokens > 0 || usage.outputTokens > 0) && (
                    <p className="ai-note ai-usage">
                      {usage.calls} request{usage.calls === 1 ? '' : 's'} · {usage.inputTokens} input
                      / {usage.outputTokens} output tokens
                      {totalWebSearches > 0 &&
                        ` · ${totalWebSearches} web search${totalWebSearches === 1 ? '' : 'es'}`}
                      {capKnown && ` · ≈ $${spentSoFar.toFixed(2)}`}
                    </p>
                  )}

                  <div className="ai-foot">
                    <button type="button" onClick={() => discardBatch()} title="Discard all proposals without applying them">
                      Discard
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => apply()}
                      disabled={applyCount === 0}
                      title={
                        applyCount === 0
                          ? 'Select at least one proposal to apply'
                          : `Apply ${applyCount} selected proposal${applyCount === 1 ? '' : 's'}`
                      }
                    >
                      Apply {applyCount}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {phase === 'applied' && applied && (
            <>
              <p>
                Filled {applied.filled - (applied.replaced ?? 0)} field
                {applied.filled - (applied.replaced ?? 0) === 1 ? '' : 's'}
                {applied.replaced ? `, replaced ${applied.replaced} answer${applied.replaced === 1 ? '' : 's'}` : ''} in{' '}
                {applied.papers} paper{applied.papers === 1 ? '' : 's'}.
                {applied.skipped > 0 && ` ${applied.skipped} were skipped.`}
              </p>
              {applied.skipped > 0 && (
                <p className="ai-note">
                  A proposal is skipped when it was left unchecked, the field is no longer empty
                  (or, for a replacement, was changed since the check), or its path no longer
                  exists in the schema.
                </p>
              )}
              <p className="ai-note">
                Everything was written as a single change: <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+
                <kbd>Z</kbd> undoes the whole fill in one step.
              </p>
              {feedbackResult && (
                <p className="ai-note">
                  {'path' in feedbackResult
                    ? `Feedback saved to ${feedbackResult.path}`
                    : `Couldn't save feedback: ${feedbackResult.error}`}
                </p>
              )}
              <div className="ai-foot">
                <button type="button" className="primary" onClick={() => closeDialog()} title="Close this dialog">
                  Close
                </button>
              </div>
            </>
          )}

          {phase === 'error' && (
            <>
              <p className="ai-error">{error ?? 'Something went wrong.'}</p>
              <p className="ai-note">
                Nothing was written to the project. If the model’s key, model name or URL is wrong,
                fix it in AI models settings and try again.
              </p>
              <div className="ai-foot">
                {gearButton}
                <span className="ai-foot-gap" />
                <button type="button" onClick={() => closeDialog()} title="Close this dialog">
                  Close
                </button>
                {!scanned && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void run()}
                    disabled={!selected || !canStart}
                    title="Retry sending the paper to the selected AI model"
                  >
                    Try again
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function RunErrors({ errors }: { errors: { paperId: string; paperTitle: string; message: string }[] }) {
  if (errors.length === 0) return null
  return (
    <details className="ai-notes ai-notes-rejected">
      <summary>
        {errors.length} paper{errors.length === 1 ? '' : 's'} failed
      </summary>
      <ul className="ai-note-list">
        {errors.map((e) => (
          <li key={e.paperId}>
            <span className="ai-field-path">{e.paperTitle}</span>
            <span className="ai-note-reason">{e.message}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Papers the reviewer skipped mid-batch (REQ-LLM-590) — not a failure, just
 *  a note that they're still eligible for a later run/resume. */
function SkippedPapers({ papers }: { papers: PaperSkip[] }) {
  if (papers.length === 0) return null
  return (
    <p className="ai-note">
      {papers.length} paper{papers.length === 1 ? '' : 's'} skipped — eligible to run again with
      "annotate all papers" or Resume.
    </p>
  )
}

function JudgeCell({ row }: { row: ReviewRow }) {
  const judge = row.suggestion.judge
  if (!judge) return <span className="ai-dash">—</span>
  const label = judge.verdict === 'accept' ? 'Accepted' : judge.verdict === 'revise' ? 'Needs revision' : 'Rejected'
  return (
    <>
      <span className={`ai-judge-verdict ai-judge-${judge.verdict}`}>{label}</span>
      {judge.feedback && <div className="ai-note-reason">{judge.feedback}</div>}
    </>
  )
}

/** A row's evidence quote is clickable when it names a passage in the paper
 *  itself — prompt mode always (no `source`), agent mode only when it didn't
 *  hand back a web URL instead. */
function isPaperEvidence(row: ReviewRow): boolean {
  return !row.suggestion.source || row.suggestion.source === 'paper'
}

function ReviewTable({
  rows,
  grouped,
  mode,
  schema,
  attentionOnly,
  onToggle,
  onEvidenceClick,
  onEdit,
}: {
  rows: ReviewRow[]
  grouped: boolean
  mode: AiMode
  /** Resolved against a row's `suggestion.path` to know what kind of edit
   *  control to show — same schema the run itself was asked about. */
  schema: ResolvedDef[]
  /** REQ-LLM-580: when on, only unticked/flagged rows render. */
  attentionOnly: boolean
  onToggle: (index: number, checked: boolean) => void
  onEvidenceClick: (row: ReviewRow) => void
  onEdit: (index: number, raw: unknown) => string | null
}) {
  // Group rows by paper, preserving first-seen order — the run processes
  // papers in that order, so this reads the same as the progress line did.
  const order: string[] = []
  for (const r of rows) if (!order.includes(r.paperId)) order.push(r.paperId)
  const hasCrossCheck = rows.some((r) => r.crossCheck)
  const columnCount = 5 + (mode === 'agent' ? 2 : 0) + (hasCrossCheck ? 1 : 0)

  // Which row (by its index in the full `rows` array) is being edited right
  // now, plus its in-progress draft and any validation error — local to this
  // table, reset whenever the edit is saved, cancelled, or another row's Edit
  // is clicked.
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<FieldValue>(null)
  const [editError, setEditError] = useState<string | null>(null)

  const startEdit = (index: number, row: ReviewRow) => {
    setEditingIndex(index)
    setDraft(row.edited && row.editedValue !== undefined ? row.editedValue : row.suggestion.value)
    setEditError(null)
  }
  const cancelEdit = () => {
    setEditingIndex(null)
    setEditError(null)
  }
  const saveEdit = (index: number) => {
    const err = onEdit(index, draft)
    if (err) {
      setEditError(err)
      return
    }
    setEditingIndex(null)
    setEditError(null)
  }

  return (
    <div className="ai-table-wrap">
      <table className="ai-table">
        <thead>
          <tr>
            <th scope="col" className="ai-col-check">
              <span className="ai-sr-only">Apply</span>
            </th>
            <th scope="col">Field</th>
            <th scope="col">Proposed value</th>
            <th scope="col">Evidence</th>
            {mode === 'agent' && <th scope="col">Source</th>}
            {mode === 'agent' && <th scope="col">Check</th>}
            {hasCrossCheck && <th scope="col">Cross-check</th>}
            <th scope="col" className="ai-col-conf">
              Confidence
            </th>
          </tr>
        </thead>
        <tbody>
          {order.map((paperId) => {
            const allGroupRows = rows
              .map((r, i) => ({ r, i }))
              .filter(({ r }) => r.paperId === paperId)
            const groupRows = attentionOnly
              ? allGroupRows.filter(({ r }) => r.flagged || !r.checked)
              : allGroupRows
            if (groupRows.length === 0) return null
            const title = allGroupRows[0]?.r.paperTitle ?? ''
            return (
              <Fragment key={paperId}>
                {grouped && (
                  <tr key={`group-${paperId}`} className="ai-group-head">
                    <th scope="colgroup" colSpan={columnCount}>
                      {title}
                    </th>
                  </tr>
                )}
                {groupRows.map(({ r: row, i }) => {
                  const label = pathLabel(row.suggestion.path)
                  return (
                    <tr key={`${row.paperId}-${row.suggestion.path}-${i}`}>
                      <td className="ai-col-check">
                        <input
                          type="checkbox"
                          checked={row.checked}
                          onChange={(e) => onToggle(i, e.target.checked)}
                          aria-label={`Apply the proposal for ${label}`}
                        />
                      </td>
                      <th scope="row" className="ai-field">
                        {label}
                      </th>
                      <td className="ai-value">
                        {editingIndex === i ? (
                          <div className="ai-edit">
                            <EditControl
                              def={resolvePath(schema, row.suggestion.path)?.def}
                              value={draft}
                              onChange={setDraft}
                            />
                            <div className="ai-edit-actions">
                              <button type="button" onClick={() => saveEdit(i)} title="Save this edited value">
                                Save
                              </button>
                              <button type="button" onClick={cancelEdit} title="Discard this edit">
                                Cancel
                              </button>
                            </div>
                            {editError && <div className="ai-note-reason ai-edit-error">{editError}</div>}
                          </div>
                        ) : (
                          <>
                            <ValueCell value={row.edited && row.editedValue !== undefined ? row.editedValue : row.suggestion.value} />
                            {row.edited && (
                              <div className="ai-note-reason">
                                edited · AI proposed: <ValueCell value={row.suggestion.value} />
                              </div>
                            )}
                            <button
                              type="button"
                              className="ai-edit-btn"
                              onClick={() => startEdit(i, row)}
                              title="Edit this proposed value before applying"
                            >
                              Edit
                            </button>
                          </>
                        )}
                      </td>
                      <td className="ai-evidence">
                        {row.suggestion.evidence ? (
                          isPaperEvidence(row) ? (
                            <button
                              type="button"
                              className="ai-evidence-link"
                              onClick={() => onEvidenceClick(row)}
                              title="Show this passage in the PDF"
                            >
                              <q>{row.suggestion.evidence}</q>
                            </button>
                          ) : (
                            <q>{row.suggestion.evidence}</q>
                          )
                        ) : (
                          <span className="ai-dash">
                            {row.suggestion.source === 'system-one' ? 'no quote (System One)' : 'no quote given'}
                          </span>
                        )}
                      </td>
                      {mode === 'agent' && (
                        <td className="ai-source">
                          {row.suggestion.source && row.suggestion.source !== 'paper' ? (
                            row.suggestion.source
                          ) : (
                            <span className="ai-dash">paper</span>
                          )}
                          {row.suggestion.webUnverified && (
                            <div>
                              <span className="ai-judge-verdict ai-judge-revise">web · quote unchecked</span>
                            </div>
                          )}
                        </td>
                      )}
                      {mode === 'agent' && (
                        <td className="ai-check">
                          <JudgeCell row={row} />
                        </td>
                      )}
                      {hasCrossCheck && (
                        <td className="ai-check">
                          {row.crossCheck ? (
                            row.crossCheck.agrees ? (
                              <span className="ai-judge-verdict ai-judge-accept">
                                ✓ {Math.round(row.crossCheck.p * 100)}%
                              </span>
                            ) : (
                              <span className="ai-judge-verdict ai-judge-reject">
                                classifier says {String(row.crossCheck.s1Value)}, p={row.crossCheck.p.toFixed(2)}
                              </span>
                            )
                          ) : (
                            <span className="ai-dash">—</span>
                          )}
                        </td>
                      )}
                      <td className="ai-col-conf">{confidenceLabel(row.suggestion.confidence)}</td>
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Re-check of values already in the seat. Only disagreements are actionable
 * and start unticked (a replacement overwrites a human answer); agreements and
 * "unsure" are listed collapsed for transparency.
 */
function RecheckSection({
  rows,
  onToggle,
  onEvidenceClick,
}: {
  rows: RecheckRow[]
  onToggle: (index: number, checked: boolean) => void
  onEvidenceClick: (row: RecheckRow) => void
}) {
  if (rows.length === 0) return null
  const indexed = rows.map((r, i) => ({ r, i }))
  const disagree = indexed.filter(({ r }) => r.outcome.verdict === 'disagree')
  const rest = indexed.filter(({ r }) => r.outcome.verdict !== 'disagree')
  const agreed = rest.filter(({ r }) => r.outcome.verdict === 'agree').length
  const papers = new Set(rows.map((r) => r.paperId)).size
  return (
    <section className="ai-recheck">
      <strong>Re-check of existing answers</strong>
      <p className="ai-note">
        The AI double-checked values already entered in this seat. Nothing is overwritten unless
        you tick a proposed replacement — replacements start unticked.
      </p>
      {disagree.length === 0 ? (
        <p className="ai-note">The AI found no answer it disagrees with.</p>
      ) : (
        <div className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr>
                <th scope="col" className="ai-col-check">
                  <span className="ai-sr-only">Replace</span>
                </th>
                {papers > 1 && <th scope="col">Paper</th>}
                <th scope="col">Field</th>
                <th scope="col">Current value</th>
                <th scope="col">AI proposes</th>
                <th scope="col">Reason</th>
                <th scope="col">Evidence</th>
                <th scope="col" className="ai-col-conf">
                  Confidence
                </th>
              </tr>
            </thead>
            <tbody>
              {disagree.map(({ r, i }) => {
                const label = pathLabel(r.outcome.path)
                return (
                  <tr key={`${r.paperId}-${r.outcome.path}-${i}`}>
                    <td className="ai-col-check">
                      <input
                        type="checkbox"
                        checked={r.checked}
                        onChange={(e) => onToggle(i, e.target.checked)}
                        aria-label={`Replace the current answer for ${label}`}
                      />
                    </td>
                    {papers > 1 && <td>{r.paperTitle}</td>}
                    <th scope="row" className="ai-field">
                      {label}
                    </th>
                    <td className="ai-value">
                      <ValueCell value={r.outcome.current} />
                    </td>
                    <td className="ai-value">
                      <ValueCell value={r.outcome.proposed ?? null} />
                    </td>
                    <td>{r.outcome.reason || <span className="ai-dash">—</span>}</td>
                    <td className="ai-evidence">
                      <button
                        type="button"
                        className="ai-evidence-link"
                        onClick={() => onEvidenceClick(r)}
                        title="Show this passage in the PDF"
                      >
                        <q>{r.outcome.evidence}</q>
                      </button>
                    </td>
                    <td className="ai-col-conf">{confidenceLabel(r.outcome.confidence)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {rest.length > 0 && (
        <details className="ai-notes">
          <summary>
            {agreed} answer{agreed === 1 ? '' : 's'} confirmed, {rest.length - agreed} unsure
          </summary>
          <ul className="ai-note-list">
            {rest.map(({ r, i }) => (
              <li key={`${r.paperId}-${r.outcome.path}-${i}`}>
                <span className="ai-field-path">
                  {papers > 1 ? `${r.paperTitle}: ` : ''}
                  {pathLabel(r.outcome.path)}
                </span>
                <span className="ai-note-reason">
                  {r.outcome.verdict === 'agree' ? 'confirmed' : 'unsure'}
                  {r.outcome.reason ? ` — ${r.outcome.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/**
 * What the model did *not* give us, for one paper. The rejected list is
 * deliberately not hidden behind a soft word: it means the model said
 * something the app refused to write.
 */
function ReviewNotes({ notes }: { notes: PaperNotes }) {
  return (
    <>
      {notes.skipped.length > 0 && (
        <details className="ai-notes">
          <summary>
            {notes.paperTitle}: the model left {notes.skipped.length} field
            {notes.skipped.length === 1 ? '' : 's'} empty
          </summary>
          <ul className="ai-note-list">
            {notes.skipped.map((s, i) => (
              <li key={`${s.path}-${i}`}>
                <span className="ai-field-path">{pathLabel(s.path)}</span>
                <span className="ai-note-reason">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {notes.rejected.length > 0 && (
        <details className="ai-notes ai-notes-rejected">
          <summary>
            {notes.paperTitle}: {notes.rejected.length} proposal
            {notes.rejected.length === 1 ? ' was' : 's were'} rejected
          </summary>
          <p className="ai-note">
            These came back from the model but did not fit the schema, so they were never offered.
          </p>
          <ul className="ai-note-list">
            {notes.rejected.map((r, i) => (
              <li key={`${r.path}-${i}`}>
                <span className="ai-field-path">{pathLabel(r.path)}</span>
                <span className="ai-note-reason">{r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

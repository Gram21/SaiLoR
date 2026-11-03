// [impl->req~llm-670~1]
// [impl->req~llm-680~1]
// [impl->req~llm-741~1]
// [impl->req~llm-742~1]
// [impl->req~llm-750~1]
import { Fragment, useEffect, useState } from 'react'
import {
  useAiStore,
  buildFewShotForPaper,
  fewShotCandidates,
  agentContextReason,
  destinationNote,
  isLocalModel,
  startBlocker,
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
import { chatInputBudget } from '../llm/budget'
import { planSystemOneRequests, systemOneEligible } from '../llm/systemone'
import type { LlmConfig } from '../llm/types'
import type { FieldValue } from '../model/annotations'
import type { ResolvedDef } from '../model/schema'
import { ComboBox } from './ComboBox'
import { Spinner } from './Spinner'
import { AiPreviewNotice } from './AiPreviewNotice'
import { useT, t, tp, rich, getLanguage, type MessageKey } from '../i18n'
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
  const t = useT()
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'ai-bool yes' : 'ai-bool no'} title={value ? t('ai.value.yes') : t('ai.value.no')}>
        {value ? '✓' : '✗'}
        <span className="ai-sr-only">{value ? t('ai.value.yes') : t('ai.value.no')}</span>
      </span>
    )
  }
  if (value === null || value === '') return <span className="ai-dash">—</span>
  return <>{String(value)}</>
}

// [impl->req~llm-580~1]
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
  const t = useT()
  if (def?.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={t('ai.edit.value')}
      />
    )
  }
  if (def?.type === 'string' && def.options && def.options.length > 0) {
    return (
      <ComboBox
        value={typeof value === 'string' ? value : null}
        options={def.options}
        onChange={(v) => onChange(v)}
        ariaLabel={t('ai.edit.value')}
      />
    )
  }
  if (def?.type === 'number' || def?.type === 'year') {
    return (
      <input
        type="number"
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        aria-label={t('ai.edit.value')}
      />
    )
  }
  return (
    <input
      type="text"
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      aria-label={t('ai.edit.value')}
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

// [impl->req~llm-430~1]
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
  /** Classify: requests the current paper needs; `approx` when it stands in for every paper. */
  systemOne: { requests: number; approx: boolean } = { requests: 1, approx: false },
): string {
  const input = {
    papers: pages.map((p) => ({ pages: p })),
    mode,
    delivery: deliveryOf(selected),
    fewShotTokens,
    contextTokens: selected.contextTokens,
    systemOneRequests: systemOne.requests,
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
  const loc = getLanguage()
  const tokens = t(mode === 'classify' && systemOne.approx ? 'ai.estimate.tokensApprox' : 'ai.estimate.tokens', {
    inLow: est.low.inputTokens.toLocaleString(loc),
    inHigh: est.high.inputTokens.toLocaleString(loc),
    outLow: est.low.outputTokens.toLocaleString(loc),
    outHigh: est.high.outputTokens.toLocaleString(loc),
    requests: tp('ai.estimate.requests', est.requests.high, { range: `${est.requests.low}–${est.requests.high}` }),
  })
  return cost
    ? t('ai.estimate.withCost', { tokens, low: `$${cost.low.toFixed(2)}`, high: `$${cost.high.toFixed(2)}` })
    : t('ai.estimate.noCost', { tokens })
}

/** Mid-range tokens per extracted page, between cost.ts's low and high guesses. */
const TOKENS_PER_PAGE = 750

// [impl->req~llm-740~1]
/** Whether the current paper probably exceeds the model's input window, from its page count alone. */
function trimHint(selected: LlmConfig, mode: AiMode, pages: number | undefined, fewShotTokens: number): string | null {
  if (mode === 'classify' || deliveryOf(selected) === 'pdf' || pages === undefined) return null
  // ponytail: 2000 = cost.ts's low system-prompt guess; a large schema trims more than this predicts.
  const budget = chatInputBudget(selected, { systemTokens: 2000 + fewShotTokens })
  if (budget === null || pages * TOKENS_PER_PAGE <= budget) return null
  const fit = Math.max(1, Math.floor(budget / TOKENS_PER_PAGE))
  return t('ai.trim.hint', { pages, model: selected.model, fit })
}

const PHASE_LINE: Record<string, MessageKey> = {
  starting: 'ai.phase.starting',
  reading: 'ai.phase.reading',
  parsing: 'ai.phase.parsing',
}

// [impl->req~llm-380~1]
const MODE_INFO: Record<AiMode, MessageKey> = {
  prompt: 'ai.mode.info.prompt',
  agent: 'ai.mode.info.agent',
  classify: 'ai.mode.info.classify',
}

/** A model with no price entered yet — shown next to a role picker so a blank
 *  cost estimate has an obvious reason. */
function priceHint(cfg: LlmConfig | null): boolean {
  return !!cfg && (cfg.inputPrice === undefined || cfg.outputPrice === undefined)
}

function modelOption(c: LlmConfig): { id: string; label: string } {
  return { id: c.id, label: `${c.name} — ${PROVIDERS[c.provider].label} · ${c.model}` }
}

// [impl->req~llm-390~1]
/** The consequences warning for turning on "annotate all papers", worded to stay
 *  accurate whichever mode is selected — shown both in the one-time confirmation
 *  and, once confirmed, as a standing reminder under the toggle. */
function allPapersWarning(mode: AiMode, count: number, recheck: boolean, local: boolean): string {
  return t('ai.allPapers.warning', {
    papers: tp('ai.papers.count', count),
    perPaper: t(mode === 'agent' ? 'ai.allPapers.perPaper.agent' : 'ai.allPapers.perPaper.prompt'),
    cost: mode === 'agent' ? `, ${t('ai.allPapers.costAgent')}` : '',
    time: t(mode === 'agent' ? 'ai.allPapers.time.agent' : 'ai.allPapers.time.prompt'),
    location: t(local ? 'ai.allPapers.local' : 'ai.allPapers.remote'),
    recheck: recheck ? ` ${t('ai.allPapers.recheck')}` : '',
  })
}

export function AiDialog() {
  const t = useT()
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

  // [impl->req~llm-460~1]
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
        title={t('ai.peek.reopenTitle')}
      >
        {t('ai.peek.back')}
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
  const running = phase === 'reading' || phase === 'starting' || phase === 'calling' || phase === 'parsing'
  const canStartSingle =
    !!currentPaper && currentPaperHasPdf && (targets.length > 0 || (recheck && answeredCount > 0))
  const webSearchSupported = !!selected && PROVIDERS[selected.provider].supportsWebSearch
  const webSearchOn = mode === 'agent' && webSearch && webSearchSupported
  const feedbackPossible = getPlatform().kind !== 'browser' && !!saveHandle?.path
  const tickedReplacements = recheckRows.filter((r) => r.outcome.verdict === 'disagree' && r.checked).length
  const applyCount = checkedCount + tickedReplacements
  const totalWebSearches = Object.values(webSearchesByPaper).reduce((n, c) => n + c, 0)
  const canStartAll = candidates.length > 0
  // Classify: what the model can take of the current paper's fields (a stand-in for every paper).
  const s1Plan =
    mode === 'classify' && selected?.provider === 'systemone' && currentPaper && targets.length > 0
      ? planSystemOneRequests(selected, currentPaper, '', targets)
      : null
  const notHandled = new Map((s1Plan?.notHandled ?? []).map((n) => [n.path, n.reason]))
  const blocker = selected ? (startBlocker(mode, selected, judgeCfg) ?? s1Plan?.error ?? null) : null
  const canStart = (allPapers ? canStartAll : canStartSingle) && !blocker
  const agentReason = selected ? agentContextReason(selected) : null

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
          { requests: Math.max(1, s1Plan?.requests.length ?? 1), approx: allPapers },
        )
      : scopePaperIds.some((id) => pageCountsLoading[id])
        ? t('ai.estimate.pending')
        : null
  const trimText =
    selected && currentPaper ? trimHint(selected, mode, pageCounts[currentPaper.id], fewShotTokens) : null
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
      title={t('ai.models.title')}
      aria-label={t('ai.models.title')}
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
        aria-label={t('ai.dialog.title')}
      >
        <div className="modal-head">
          <strong>{t('ai.dialog.title')}</strong>
          <button
            type="button"
            className="icon-btn"
            onClick={() => closeDialog()}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          <AiPreviewNotice />
          {phase === 'setup' && (
            <>
              {resumeAvailable && (
                <div className="ai-confirm">
                  <p className="ai-note">
                    {t('ai.resume.stopped', { done: resumeAvailable.doneIds.length, total: resumeAvailable.allPaperIds.length, date: new Date(resumeAvailable.startedAt).toLocaleString(getLanguage()) })}
                  </p>
                  <div className="ai-foot">
                    <button
                      type="button"
                      onClick={() => dismissResume()}
                      title={t('ai.resume.discardTitle')}
                    >
                      {t('ai.action.discard')}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void resumeBatch()}
                      title={t('ai.resume.resumeTitle')}
                    >
                      {t('ai.action.resume')}
                    </button>
                  </div>
                </div>
              )}

              {configs.length === 0 && (
                <div className="ai-empty-configs">
                  <p>{t('ai.empty.noModel')}</p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setSettingsOpen(true)}
                    title={t('ai.empty.setUpTitle')}
                  >
                    {t('ai.action.setUp')}
                  </button>
                </div>
              )}

              {/* What: scope (current paper vs. all papers) and which fields will be asked. */}
              <div className="ai-label" id="ai-what-label">
                {t('ai.section.what')}
              </div>
              <p className="ai-scope">
                {allPapers
                  ? rich('ai.scope.all', { papers: tp('ai.papers.count', candidates.length) })
                  : rich('ai.scope.current', { title: currentPaper?.title ?? '—' })}
              </p>
              {!allPapers && currentPaper && !currentPaperHasPdf && (
                <p className="ai-note">{t('ai.scope.noPdf')}</p>
              )}

              <label className="ai-toggle-row">
                <input
                  type="checkbox"
                  checked={allPapers}
                  onChange={(e) => onToggleAllPapers(e.target.checked)}
                />
                {t('ai.toggle.allPapers')}
              </label>

              {pendingAllPapers && !allPapers && (
                <div className="ai-confirm">
                  <p className="ai-note">{allPapersWarning(mode, candidates.length, recheck, !!selected && isLocalModel(selected))}</p>
                  <div className="ai-foot">
                    <button type="button" onClick={() => setPendingAllPapers(false)} title={t('ai.allPapers.keepCurrentTitle')}>
                      {t('ai.action.currentOnly')}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setAllPapers(true)
                        setPendingAllPapers(false)
                      }}
                      disabled={candidates.length === 0}
                      title={t('ai.allPapers.enableTitle')}
                    >
                      {t('ai.allPapers.annotateAll', { count: candidates.length })}
                    </button>
                  </div>
                </div>
              )}
              {allPapers && <p className="ai-note">{allPapersWarning(mode, candidates.length, recheck, !!selected && isLocalModel(selected))}</p>}

              <p className="ai-targets">
                {targets.length === 0
                  ? recheck && answeredCount > 0
                    ? t('ai.targets.onlyRecheck')
                    : t('ai.targets.none')
                  : tp('ai.targets.count', targets.length)}
              </p>

              {targets.length > 0 && (
                <details className="ai-prompt">
                  <summary>{t('ai.targets.summary', { count: targets.length })}</summary>
                  <p className="ai-note">
                    {t('ai.targets.note')}
                    {allPapers && ` ${t('ai.targets.allPapersNote')}`}
                  </p>
                  <ul className="ai-field-list">
                    {targets.map((target) => (
                      <li key={target.path}>
                        <span className="ai-field-path">{pathLabel(target.path)}</span>
                        <span className="ai-field-type">{target.def.type}</span>
                        {target.def.options && target.def.options.length > 0 && (
                          <span className="ai-field-options">
                            {t('ai.targets.oneOf', { options: target.def.options.join(' · ') })}
                          </span>
                        )}
                        {mode === 'classify' && !systemOneEligible(target) && (
                          <span className="ai-note-reason">{t('ai.classify.notHandled')}</span>
                        )}
                        {notHandled.has(target.path) && (
                          <span className="ai-note-reason">
                            {t('ai.targets.notHandledBy', { model: selected?.model ?? '', reason: notHandled.get(target.path) ?? '' })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* How: prompt / agent / classify. */}
              <div className="ai-label" id="ai-mode-label">
                {t('ai.section.how')}
              </div>
              <div className="ai-mode-row" role="radiogroup" aria-labelledby="ai-mode-label">
                <label>
                  <input
                    type="radio"
                    name="ai-mode"
                    checked={mode === 'prompt'}
                    onChange={() => setMode('prompt')}
                  />
                  {t('ai.mode.prompt')}
                </label>
                <label title={agentReason ?? undefined}>
                  <input
                    type="radio"
                    name="ai-mode"
                    checked={mode === 'agent'}
                    disabled={!!agentReason}
                    onChange={() => setMode('agent')}
                  />
                  {t('ai.mode.agent')}
                </label>
                <label
                  title={
                    systemOneConfigs.length === 0
                      ? t('ai.mode.classifyHint')
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
                  {t('ai.mode.classify')}
                </label>
              </div>
              <p className="ai-note">{t(MODE_INFO[mode])}</p>

              {/* Models: assign a library model to each role. */}
              <div className="ai-label" id="ai-models-label">
                {t('ai.section.models')}
              </div>

              <div className="ai-label" id="ai-annotator-label">
                {t('ai.section.annotator')}
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
              {priceHint(selected) && <p className="ai-note">{t('ai.price.none')}</p>}

              {mode === 'agent' && (
                <>
                  <div className="ai-label" id="ai-judge-label">
                    {t('ai.section.judge')}
                  </div>
                  <div className="ai-target-row" role="group" aria-labelledby="ai-judge-label">
                    <ComboBox
                      value={judgeSelectedId ?? ''}
                      options={[
                        {
                          id: '',
                          label: selected ? t('ai.judge.sameAsNamed', { name: selected.name }) : t('ai.judge.sameAs'),
                        },
                        ...chatConfigs.map(modelOption),
                      ]}
                      onChange={(id) => selectJudge(id || null)}
                    />
                  </div>
                  <p className="ai-note">{t('ai.judge.note')}</p>
                  {priceHint(judgeCfg) && <p className="ai-note">{t('ai.price.none')}</p>}
                </>
              )}

              {mode !== 'classify' && systemOneConfigs.length > 0 && (
                <>
                  <div className="ai-label" id="ai-crosscheck-label">
                    {t('ai.section.crossCheck')}
                  </div>
                  <div className="ai-target-row" role="group" aria-labelledby="ai-crosscheck-label">
                    <ComboBox
                      value={crossCheckId ?? ''}
                      options={[{ id: '', label: t('ai.crossCheck.none') }, ...systemOneConfigs.map(modelOption)]}
                      onChange={(id) => selectCrossCheck(id || null)}
                    />
                  </div>
                  <p className="ai-note">{t('ai.crossCheck.note')}</p>
                  {priceHint(crossCheckCfg) && <p className="ai-note">{t('ai.price.none')}</p>}
                </>
              )}

              {aiSeat && project && (
                <p className="ai-note">
                  {rich('ai.seat.note', { seat: seatLabel(project, aiSeat) })}
                </p>
              )}

              <p className="ai-consent">
                {selected ? (
                  <>
                    {rich(
                      mode === 'classify'
                        ? 'ai.consent.classify'
                        : deliveryOf(selected) === 'pdf'
                          ? allPapers
                            ? 'ai.consent.pdfEach'
                            : 'ai.consent.pdfThis'
                          : 'ai.consent.text',
                      {
                        scope: t(allPapers ? 'ai.consent.scopeEach' : 'ai.consent.scopeThis'),
                        provider: PROVIDERS[selected.provider].label,
                        model: selected.model,
                        destination: destinationNote(selected),
                      },
                    )}
                    {mode === 'agent' && ` ${t('ai.consent.agentSearch')}`}
                    {mode === 'agent' &&
                      judgeCfg &&
                      judgeCfg.provider !== selected.provider &&
                      ` ${t('ai.consent.judge', { provider: PROVIDERS[judgeCfg.provider].label, model: judgeCfg.model })}`}
                    {webSearchOn &&
                      ` ${t('ai.consent.webSearch', { provider: PROVIDERS[selected.provider].label })}`}
                    {mode !== 'classify' &&
                      crossCheckCfg &&
                      ` ${t('ai.consent.crossCheck', { provider: PROVIDERS[crossCheckCfg.provider].label, model: crossCheckCfg.model })}`}
                    {mode !== 'classify' &&
                      fewShot &&
                      fewShotAvailable > 0 &&
                      ` ${t('ai.consent.fewShot', { count: Math.min(fewShotCount, fewShotAvailable) })}`}
                  </>
                ) : (
                  t('ai.consent.nothingSent')
                )}
              </p>

              {estimateText && <p className="ai-note ai-estimate">{estimateText}</p>}
              {trimText && <p className="ai-note">{trimText}</p>}
              {blocker && <p className="ai-note ai-error">{blocker}</p>}

              {/* Options: everything a run doesn't strictly need to choose. */}
              <details className="ai-prompt">
                <summary>{t('ai.options.summary')}</summary>

                {mode !== 'classify' && (
                  <>
                    <label className="ai-toggle-row">
                      <input
                        type="checkbox"
                        checked={fewShot}
                        disabled={fewShotAvailable === 0}
                        onChange={(e) => setFewShot(e.target.checked)}
                      />
                      {t('ai.fewShot.toggle')}
                    </label>
                    <p className="ai-note">
                      {fewShotAvailable === 0 ? t('ai.fewShot.none') : tp('ai.fewShot.available', fewShotAvailable)}
                    </p>
                    {fewShot && fewShotAvailable > 0 && (
                      <div className="ai-target-row">
                        <label htmlFor="ai-fewshot-count">{t('ai.fewShot.showUpTo')}</label>
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
                  {t('ai.recheck.toggle')}
                </label>
                <p className="ai-note">
                  {t('ai.recheck.note')}
                  {mode !== 'prompt' && ` ${t('ai.recheck.promptOnly')}`}
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
                      {t('ai.webSearch.toggle')}
                    </label>
                    <p className="ai-note">
                      {webSearchSupported
                        ? WEB_SEARCH_NOTE
                        : t('ai.webSearch.unsupported')}
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
                  {t('ai.feedback.toggle')}
                </label>
                <p className="ai-note">
                  {t('ai.feedback.note')}
                  {!feedbackPossible &&
                    ` ${getPlatform().kind !== 'browser' ? t('ai.feedback.saveFirst') : t('ai.feedback.desktopOnly')}`}
                </p>

                {allPapers && (
                  <div className="ai-target-row">
                    <label htmlFor="ai-concurrency">{t('ai.concurrency.label')}</label>
                    <select
                      id="ai-concurrency"
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                      title={t('ai.concurrency.title')}
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
                    <label htmlFor="ai-spend-cap">{t('ai.spendCap.label')}</label>
                    <input
                      id="ai-spend-cap"
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={!capKnown}
                      value={spendCap ?? ''}
                      onChange={(e) => setSpendCap(e.target.value === '' ? null : Number(e.target.value))}
                      placeholder={capKnown ? t('ai.spendCap.noLimit') : t('ai.spendCap.setPrices')}
                      title={
                        capKnown
                          ? t('ai.spendCap.titleOn')
                          : t('ai.spendCap.titleOff')
                      }
                    />
                  </div>
                )}

                {(mode === 'classify' || crossCheckCfg) && (
                  <div className="ai-target-row">
                    <label htmlFor="ai-threshold">{t('ai.threshold.label')}</label>
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
                          ? t('ai.threshold.titleClassify')
                          : t('ai.threshold.titleCross')
                      }
                    />
                  </div>
                )}
              </details>

              <div className="ai-foot">
                <button type="button" onClick={() => closeDialog()} title={t('ai.setup.cancelTitle')}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void run()}
                  disabled={!selected || !canStart}
                  title={blocker ?? t('ai.start.title')}
                >
                  {t('ai.action.start')}
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
                    ? t('ai.phase.calling', { model: selected?.model ?? t('ai.phase.theModel') })
                    : t(PHASE_LINE[phase])}
                </span>
                <span className="ai-elapsed">{elapsed}s</span>
              </div>
              {batchTotal > 1 && (
                <>
                  <p className="ai-note">
                    {t('ai.batch.progress', { done: batchDone, total: batchTotal })}
                    {capKnown && ` · ${t('ai.batch.spent', { amount: `$${spentSoFar.toFixed(2)}` })}`}
                  </p>
                  {inFlightPapers.length > 0 && (
                    <ul className="ai-note-list ai-inflight-list">
                      {inFlightPapers.map((p) => (
                        <li key={p.id}>
                          {p.title}
                          <button
                            type="button"
                            onClick={() => skipPaper(p.id)}
                            title={t('ai.inflight.skipTitle')}
                          >
                            {t('ai.action.skip')}
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
              <p className="ai-note">{t('ai.running.hint')}</p>
              <div className="ai-foot">
                <button type="button" onClick={() => cancel()} title={t('ai.running.cancelTitle')}>
                  {t('common.cancel')}
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
                    title={t('ai.review.continueTitle')}
                  >
                    {tp('ai.review.continueRemaining', batchTotal - batchDone)}
                  </button>
                </p>
              )}

              <SkippedPapers papers={skippedPapers} />

              {rows.length === 0 && recheckRows.length === 0 ? (
                <>
                  <p>{t('ai.review.noValues')}</p>
                  <RunErrors errors={runErrors} />
                  {notes.map((n) => (
                    <ReviewNotes key={n.paperId} notes={n} />
                  ))}
                  <div className="ai-foot">
                    <button type="button" className="primary" onClick={() => closeDialog()} title={t('ai.dialog.closeTitle')}>
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
                          <button type="button" onClick={() => setAllRows(true)} title={t('ai.review.selectAllTitle')}>
                            {t('ai.action.selectAll')}
                          </button>
                          <button type="button" onClick={() => setAllRows(false)} title={t('ai.review.selectNoneTitle')}>
                            {t('ai.action.selectNone')}
                          </button>
                        </div>
                        <span className="ai-count">
                          {t('ai.review.selected', { checked: checkedCount, total: rows.length })}
                        </span>
                      </div>

                      <RunErrors errors={runErrors} />

                      {spendCapHit && (
                        <p className="ai-note ai-cap-hit">
                          {t('ai.spendCap.hit', { amount: `$${spentSoFar.toFixed(2)}` })}
                        </p>
                      )}

                      {attentionRows.length > 0 && (
                        <p className="ai-note">{tp('ai.review.attention', attentionRows.length)}</p>
                      )}
                      <label className="ai-toggle-row">
                        <input
                          type="checkbox"
                          checked={attentionOnly}
                          disabled={attentionRows.length === 0}
                          onChange={(e) => setAttentionOnly(e.target.checked)}
                        />
                        {t('ai.review.attentionOnly')}
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
                      {tp('ai.usage.requests', usage.calls)} · {t('ai.usage.tokens', { input: usage.inputTokens, output: usage.outputTokens })}
                      {totalWebSearches > 0 && ` · ${tp('ai.usage.webSearches', totalWebSearches)}`}
                      {capKnown && ` · ≈ $${spentSoFar.toFixed(2)}`}
                    </p>
                  )}

                  <div className="ai-foot">
                    <button type="button" onClick={() => discardBatch()} title={t('ai.review.discardTitle')}>
                      {t('ai.action.discard')}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => apply()}
                      disabled={applyCount === 0}
                      title={
                        applyCount === 0
                          ? t('ai.review.applyNone')
                          : tp('ai.review.applyCount', applyCount)
                      }
                    >
                      {t('ai.review.applyButton', { count: applyCount })}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {phase === 'applied' && applied && (
            <>
              <p>
                {t('ai.applied.summary', {
                  fields: tp('ai.applied.fields', applied.filled - (applied.replaced ?? 0)),
                  replaced: applied.replaced ? `, ${tp('ai.applied.replaced', applied.replaced)}` : '',
                  papers: tp('ai.papers.count', applied.papers),
                })}
                {applied.skipped > 0 && ` ${t('ai.applied.skipped', { count: applied.skipped })}`}
              </p>
              {applied.skipped > 0 && (
                <p className="ai-note">{t('ai.applied.skipNote')}</p>
              )}
              <p className="ai-note">{rich('ai.applied.undo')}</p>
              {feedbackResult && (
                <p className="ai-note">
                  {'path' in feedbackResult
                    ? t('ai.feedback.saved', { path: feedbackResult.path })
                    : t('ai.feedback.failed', { error: feedbackResult.error })}
                </p>
              )}
              <div className="ai-foot">
                <button type="button" className="primary" onClick={() => closeDialog()} title={t('ai.dialog.closeTitle')}>
                  Close
                </button>
              </div>
            </>
          )}

          {phase === 'error' && (
            <>
              <p className="ai-error">{error ?? t('ai.error.generic')}</p>
              <p className="ai-note">{t('ai.error.nothingWritten')}</p>
              <div className="ai-foot">
                {gearButton}
                <span className="ai-foot-gap" />
                <button type="button" onClick={() => closeDialog()} title={t('ai.dialog.closeTitle')}>
                  Close
                </button>
                {!scanned && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void run()}
                    disabled={!selected || !canStart}
                    title={t('ai.error.retryTitle')}
                  >
                    {t('ai.action.tryAgain')}
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
  useT()
  if (errors.length === 0) return null
  return (
    <details className="ai-notes ai-notes-rejected">
      <summary>
        {tp('ai.runErrors.failed', errors.length)}
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

// [impl->req~llm-590~1]
/** Papers the reviewer skipped mid-batch (REQ-LLM-590) — not a failure, just
 *  a note that they're still eligible for a later run/resume. */
function SkippedPapers({ papers }: { papers: PaperSkip[] }) {
  useT()
  if (papers.length === 0) return null
  return (
    <p className="ai-note">{tp('ai.skipped.summary', papers.length)}</p>
  )
}

// [impl->req~llm-410~1]
function JudgeCell({ row }: { row: ReviewRow }) {
  const t = useT()
  const judge = row.suggestion.judge
  if (!judge) return <span className="ai-dash">—</span>
  const label = judge.verdict === 'accept' ? t('ai.judge.accepted') : judge.verdict === 'revise' ? t('ai.judge.revise') : t('ai.judge.rejected')
  return (
    <>
      <span className={`ai-judge-verdict ai-judge-${judge.verdict}`}>{label}</span>
      {judge.feedback && <div className="ai-note-reason">{judge.feedback}</div>}
    </>
  )
}

// [impl->req~llm-460~1]
/** A row's evidence quote is clickable when it names a passage in the paper
 *  itself — prompt mode always (no `source`), agent mode only when it didn't
 *  hand back a web URL instead. */
function isPaperEvidence(row: ReviewRow): boolean {
  return !row.suggestion.source || row.suggestion.source === 'paper'
}

// [impl->req~llm-210~1]
// [impl->req~llm-580~1]
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
  const t = useT()
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
              <span className="ai-sr-only">{t('common.apply')}</span>
            </th>
            <th scope="col">{t('ai.table.field')}</th>
            <th scope="col">{t('ai.table.proposed')}</th>
            <th scope="col">{t('ai.table.evidence')}</th>
            {mode === 'agent' && <th scope="col">{t('ai.table.source')}</th>}
            {mode === 'agent' && <th scope="col">{t('ai.table.check')}</th>}
            {hasCrossCheck && <th scope="col">{t('ai.table.crossCheck')}</th>}
            <th scope="col" className="ai-col-conf">
              {t('ai.table.confidence')}
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
                          aria-label={t('ai.table.applyFor', { field: label })}
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
                              <button type="button" onClick={() => saveEdit(i)} title={t('ai.edit.saveTitle')}>
                                {t('common.save')}
                              </button>
                              <button type="button" onClick={cancelEdit} title={t('ai.edit.discardTitle')}>
                                {t('common.cancel')}
                              </button>
                            </div>
                            {editError && <div className="ai-note-reason ai-edit-error">{editError}</div>}
                          </div>
                        ) : (
                          <>
                            <ValueCell value={row.edited && row.editedValue !== undefined ? row.editedValue : row.suggestion.value} />
                            {row.edited && (
                              <div className="ai-note-reason">
                                {t('ai.edit.edited')} <ValueCell value={row.suggestion.value} />
                              </div>
                            )}
                            <button
                              type="button"
                              className="ai-edit-btn"
                              onClick={() => startEdit(i, row)}
                              title={t('ai.edit.title')}
                            >
                              {t('common.edit')}
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
                              title={t('ai.evidence.show')}
                            >
                              <q>{row.suggestion.evidence}</q>
                            </button>
                          ) : (
                            <q>{row.suggestion.evidence}</q>
                          )
                        ) : (
                          <span className="ai-dash">
                            {row.suggestion.source === 'system-one' ? t('ai.evidence.noQuoteSystemOne') : t('ai.evidence.none')}
                          </span>
                        )}
                      </td>
                      {mode === 'agent' && (
                        <td className="ai-source">
                          {row.suggestion.source && row.suggestion.source !== 'paper' ? (
                            row.suggestion.source
                          ) : (
                            <span className="ai-dash">{t('ai.source.paper')}</span>
                          )}
                          {row.suggestion.webUnverified && (
                            <div>
                              <span className="ai-judge-verdict ai-judge-revise">{t('ai.source.webUnverified')}</span>
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
                                {t('ai.crossCheck.says', { value: String(row.crossCheck.s1Value), p: row.crossCheck.p.toFixed(2) })}
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

// [impl->req~llm-660~1]
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
  const t = useT()
  if (rows.length === 0) return null
  const indexed = rows.map((r, i) => ({ r, i }))
  const disagree = indexed.filter(({ r }) => r.outcome.verdict === 'disagree')
  const rest = indexed.filter(({ r }) => r.outcome.verdict !== 'disagree')
  const agreed = rest.filter(({ r }) => r.outcome.verdict === 'agree').length
  const papers = new Set(rows.map((r) => r.paperId)).size
  return (
    <section className="ai-recheck">
      <strong>{t('ai.recheck.heading')}</strong>
      <p className="ai-note">{t('ai.recheck.explain')}</p>
      {disagree.length === 0 ? (
        <p className="ai-note">{t('ai.recheck.noneDisagree')}</p>
      ) : (
        <div className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr>
                <th scope="col" className="ai-col-check">
                  <span className="ai-sr-only">{t('ai.recheck.replace')}</span>
                </th>
                {papers > 1 && <th scope="col">{t('ai.table.paper')}</th>}
                <th scope="col">{t('ai.table.field')}</th>
                <th scope="col">{t('ai.table.current')}</th>
                <th scope="col">{t('ai.table.aiProposes')}</th>
                <th scope="col">{t('ai.table.reason')}</th>
                <th scope="col">{t('ai.table.evidence')}</th>
                <th scope="col" className="ai-col-conf">
                  {t('ai.table.confidence')}
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
                        aria-label={t('ai.recheck.replaceFor', { field: label })}
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
                        title={t('ai.evidence.show')}
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
            {t('ai.recheck.summary', { confirmed: tp('ai.recheck.confirmedCount', agreed), unsure: rest.length - agreed })}
          </summary>
          <ul className="ai-note-list">
            {rest.map(({ r, i }) => (
              <li key={`${r.paperId}-${r.outcome.path}-${i}`}>
                <span className="ai-field-path">
                  {papers > 1 ? `${r.paperTitle}: ` : ''}
                  {pathLabel(r.outcome.path)}
                </span>
                <span className="ai-note-reason">
                  {r.outcome.verdict === 'agree' ? t('ai.recheck.verdictConfirmed') : t('ai.recheck.verdictUnsure')}
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

// [impl->req~llm-740~1]
/**
 * What the model did *not* give us, for one paper. The rejected list is
 * deliberately not hidden behind a soft word: it means the model said
 * something the app refused to write.
 */
function ReviewNotes({ notes }: { notes: PaperNotes }) {
  const t = useT()
  return (
    <>
      {notes.info?.map((m, i) => (
        <p key={i} className="ai-note">
          {notes.paperTitle}: {m}
        </p>
      ))}
      {notes.skipped.length > 0 && (
        <details className="ai-notes">
          <summary>
            {tp('ai.notes.skipped', notes.skipped.length, { title: notes.paperTitle })}
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
            {tp('ai.notes.rejected', notes.rejected.length, { title: notes.paperTitle })}
          </summary>
          <p className="ai-note">
            {t('ai.notes.rejectedNote')}
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

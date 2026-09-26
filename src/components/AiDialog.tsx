import { Fragment, useEffect, useState } from 'react'
import { useAiStore, type AiMode, type PaperNotes, type ReviewRow } from '../state/aiStore'
import { useStore } from '../state/store'
import { PROVIDERS } from '../llm/providers'
import { displayPath, parsePath } from '../llm/paths'
import type { LlmConfig } from '../llm/types'
import type { FieldValue } from '../model/annotations'
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
}

/** The consequences warning for turning on "annotate all papers", worded to stay
 *  accurate whichever mode is selected — shown both in the one-time confirmation
 *  and, once confirmed, as a standing reminder under the toggle. */
function allPapersWarning(mode: AiMode, count: number): string {
  const perPaper = mode === 'agent' ? 'many requests per paper' : 'one request per paper'
  const time = mode === 'agent' ? 'several minutes per paper' : 'about a minute per paper'
  const cost = mode === 'agent' ? ', several times higher than prompt mode' : ''
  return (
    `This sends ${count} paper${count === 1 ? '' : 's'} — ${perPaper}. Your provider charges ` +
    `your API key for every request, so cost scales with the number of papers${cost}. Rough ` +
    `estimate: ${time}. Every paper's content leaves this machine. You can cancel at any time ` +
    'and keep whatever has finished so far.'
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
  const batchIndex = useAiStore((s) => s.batchIndex)
  const batchTotal = useAiStore((s) => s.batchTotal)
  const batchTitle = useAiStore((s) => s.batchTitle)
  const agentEvents = useAiStore((s) => s.agentEvents)
  const runErrors = useAiStore((s) => s.errors)
  const usage = useAiStore((s) => s.usage)

  const closeDialog = useAiStore((s) => s.closeDialog)
  const setMinimized = useAiStore((s) => s.setMinimized)
  const setSettingsOpen = useAiStore((s) => s.setSettingsOpen)
  const selectConfig = useAiStore((s) => s.selectConfig)
  const setMode = useAiStore((s) => s.setMode)
  const setAllPapers = useAiStore((s) => s.setAllPapers)
  const run = useAiStore((s) => s.run)
  const cancel = useAiStore((s) => s.cancel)
  const toggleRow = useAiStore((s) => s.toggleRow)
  const setAllRows = useAiStore((s) => s.setAllRows)
  const apply = useAiStore((s) => s.apply)

  const currentPaper = useStore((s) => s.project?.papers.find((p) => p.id === s.currentPaperId))
  const currentPaperId = useStore((s) => s.currentPaperId)
  const selectPaper = useStore((s) => s.selectPaper)
  const requestPdfFind = useStore((s) => s.requestPdfFind)

  /** Clicking a paper-sourced evidence quote: switch to that paper if needed,
   *  ask `PdfViewer` to find+highlight it, and peek at the PDF (see `minimized`). */
  const jumpToEvidence = (row: ReviewRow) => {
    if (row.paperId !== currentPaperId) selectPaper(row.paperId)
    requestPdfFind(row.paperId, row.suggestion.evidence)
    setMinimized(true)
  }

  // The one-time consequences warning is local UI state: it is shown between
  // ticking the toggle and confirming, and never persisted.
  const [pendingAllPapers, setPendingAllPapers] = useState(false)

  useEffect(() => {
    if (phase !== 'setup') setPendingAllPapers(false)
  }, [phase])

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
  const checkedCount = rows.filter((r) => r.checked).length
  const running = phase === 'reading' || phase === 'calling' || phase === 'parsing'
  const canStartSingle = !!currentPaper && currentPaperHasPdf && targets.length > 0
  const canStartAll = candidates.length > 0
  const canStart = allPapers ? canStartAll : canStartSingle

  // Grouped only when more than one paper is actually in the review set.
  const paperOrder: string[] = []
  for (const r of rows) if (!paperOrder.includes(r.paperId)) paperOrder.push(r.paperId)
  const grouped = paperOrder.length > 1

  const gearButton = (
    <button
      type="button"
      className="icon-btn"
      onClick={() => setSettingsOpen(true)}
      title="LLM settings"
      aria-label="LLM settings"
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
              {configs.length === 0 ? (
                <div className="ai-empty-configs">
                  <p>No LLM target is set up yet.</p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setSettingsOpen(true)}
                    title="Open LLM settings to add a target"
                  >
                    Set up an LLM…
                  </button>
                </div>
              ) : (
                <>
                  <div className="ai-label" id="ai-target-label">
                    Send to
                  </div>
                  <div className="ai-target-row" role="group" aria-labelledby="ai-target-label">
                    <ComboBox
                      value={selectedId}
                      options={configs.map((c) => ({
                        id: c.id,
                        label: `${c.name} — ${PROVIDERS[c.provider].label} · ${c.model}`,
                      }))}
                      onChange={(id) => {
                        if (id) selectConfig(id)
                      }}
                    />
                    {gearButton}
                  </div>
                </>
              )}

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
              </div>
              <p className="ai-note">{MODE_INFO[mode]}</p>

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
                  <p className="ai-note">{allPapersWarning(mode, candidates.length)}</p>
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
              {allPapers && <p className="ai-note">{allPapersWarning(mode, candidates.length)}</p>}

              <p className="ai-consent">
                {selected ? (
                  <>
                    {deliveryOf(selected) === 'pdf'
                      ? `This paper${allPapers ? "'s" : '’s'} PDF file will be sent to `
                      : `The text of ${allPapers ? 'each paper' : 'this paper'} will be extracted and sent to `}
                    <strong>{PROVIDERS[selected.provider].label}</strong> ({selected.model}). It
                    leaves this machine. Nothing is written into the project until you press Apply.
                    {mode === 'agent' &&
                      ' Agent mode may also send search terms or URLs chosen by the model to OpenAlex, Crossref, or other sites; these can contain short phrases from the paper, but never the paper file itself.'}
                  </>
                ) : (
                  'Nothing is sent until you choose a target and press Start.'
                )}
              </p>

              <p className="ai-targets">
                {targets.length === 0
                  ? 'Every field of this paper is already filled in — there is nothing to propose.'
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
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="ai-foot">
                <button type="button" onClick={() => closeDialog()} title="Cancel without sending anything">
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void run()}
                  disabled={!selected || !canStart}
                  title="Send the paper(s) to the selected LLM target"
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
                <p className="ai-note">
                  Paper {batchIndex} of {batchTotal} — {batchTitle}
                </p>
              )}
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
              {rows.length === 0 ? (
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

                  <ReviewTable
                    rows={rows}
                    grouped={grouped}
                    mode={mode}
                    onToggle={toggleRow}
                    onEvidenceClick={jumpToEvidence}
                  />

                  {notes.map((n) => (
                    <ReviewNotes key={n.paperId} notes={n} />
                  ))}

                  {(usage.calls > 0 || usage.inputTokens > 0 || usage.outputTokens > 0) && (
                    <p className="ai-note ai-usage">
                      {usage.calls} request{usage.calls === 1 ? '' : 's'} · {usage.inputTokens} input
                      / {usage.outputTokens} output tokens
                    </p>
                  )}

                  <div className="ai-foot">
                    <button type="button" onClick={() => closeDialog()} title="Discard all proposals without applying them">
                      Discard
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => apply()}
                      disabled={checkedCount === 0}
                      title={
                        checkedCount === 0
                          ? 'Select at least one proposal to apply'
                          : `Apply ${checkedCount} selected proposal${checkedCount === 1 ? '' : 's'}`
                      }
                    >
                      Apply {checkedCount}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {phase === 'applied' && applied && (
            <>
              <p>
                Filled {applied.filled} field{applied.filled === 1 ? '' : 's'} in {applied.papers}{' '}
                paper{applied.papers === 1 ? '' : 's'}.
                {applied.skipped > 0 && ` ${applied.skipped} were skipped.`}
              </p>
              {applied.skipped > 0 && (
                <p className="ai-note">
                  A proposal is skipped when it was left unchecked, the field is no longer empty,
                  or its path no longer exists in the schema.
                </p>
              )}
              <p className="ai-note">
                Everything was written as a single change: <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+
                <kbd>Z</kbd> undoes the whole fill in one step.
              </p>
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
                Nothing was written to the project. If the target’s key, model name or URL is wrong,
                fix it in the LLM settings and try again.
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
                    title="Retry sending the paper to the selected LLM target"
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
  onToggle,
  onEvidenceClick,
}: {
  rows: ReviewRow[]
  grouped: boolean
  mode: AiMode
  onToggle: (index: number, checked: boolean) => void
  onEvidenceClick: (row: ReviewRow) => void
}) {
  // Group rows by paper, preserving first-seen order — the run processes
  // papers in that order, so this reads the same as the progress line did.
  const order: string[] = []
  for (const r of rows) if (!order.includes(r.paperId)) order.push(r.paperId)

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
            <th scope="col" className="ai-col-conf">
              Confidence
            </th>
          </tr>
        </thead>
        <tbody>
          {order.map((paperId) => {
            const groupRows = rows
              .map((r, i) => ({ r, i }))
              .filter(({ r }) => r.paperId === paperId)
            const title = groupRows[0]?.r.paperTitle ?? ''
            return (
              <Fragment key={paperId}>
                {grouped && (
                  <tr key={`group-${paperId}`} className="ai-group-head">
                    <th scope="colgroup" colSpan={mode === 'agent' ? 7 : 5}>
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
                        <ValueCell value={row.suggestion.value} />
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
                          <span className="ai-dash">no quote given</span>
                        )}
                      </td>
                      {mode === 'agent' && (
                        <td className="ai-source">
                          {row.suggestion.source && row.suggestion.source !== 'paper' ? (
                            row.suggestion.source
                          ) : (
                            <span className="ai-dash">paper</span>
                          )}
                        </td>
                      )}
                      {mode === 'agent' && (
                        <td className="ai-check">
                          <JudgeCell row={row} />
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

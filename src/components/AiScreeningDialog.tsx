import { useEffect, useState } from 'react'
import {
  useAiScreeningStore,
  effectiveConfig,
  modelsFor,
  type ScreeningEngine,
  type ScreeningNote,
} from '../state/aiScreeningStore'
import { useAiStore } from '../state/aiStore'
import { useStore } from '../state/store'
import { seatLabel } from '../model/project'
import { PROVIDERS } from '../llm/providers'
import type { LlmConfig } from '../llm/types'
import { ComboBox } from './ComboBox'
import { Spinner } from './Spinner'
import '../styles/ai.css'

/**
 * The AI-assisted screening dialog: a view over `useAiScreeningStore`. Nothing
 * is sent until Start, nothing is written until Apply, and Exclude proposals
 * never start ticked (a wrongly excluded paper silently leaves the review).
 */

const ENGINE_INFO: Record<ScreeningEngine, string> = {
  prompt: 'A chat model reads the title and abstract against your protocol and replies with a decision, reason, quote and confidence.',
  classify:
    'A System One decision model answers two closed questions per paper (the decision, then the exclusion reason) with a calibrated probability. No written justification.',
}

function modelOption(c: LlmConfig): { id: string; label: string } {
  return { id: c.id, label: `${c.name} — ${PROVIDERS[c.provider].label} · ${c.model}` }
}

function allPapersWarning(count: number): string {
  return (
    `This sends ${count} paper${count === 1 ? '' : 's'} — one request per paper. Your provider charges ` +
    'your API key for every request, so cost scales with the number of papers. Every paper’s title, ' +
    'authors and abstract leave this machine. You can cancel at any time and keep whatever has finished so far.'
  )
}

function Notes({ label, items }: { label: string; items: ScreeningNote[] }) {
  if (items.length === 0) return null
  return (
    <details className="ai-notes ai-notes-rejected">
      <summary>
        {items.length} paper{items.length === 1 ? '' : 's'} {label}
      </summary>
      <ul className="ai-note-list">
        {items.map((e) => (
          <li key={e.paperId}>
            <span className="ai-field-path">{e.paperTitle}</span>
            <span className="ai-note-reason">{e.message}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function AiScreeningDialog() {
  const s = useAiScreeningStore()
  const configs = useAiStore((a) => a.configs)
  const modelSettingsOpen = useAiStore((a) => a.settingsOpen)
  const project = useStore((a) => a.project)
  const currentPaperId = useStore((a) => a.currentPaperId)
  const [pendingAll, setPendingAll] = useState(false)

  useEffect(() => {
    if (!s.open || modelSettingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') s.closeDialog()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [s.open, modelSettingsOpen, s.closeDialog])

  if (!s.open || !project?.screening) return null

  const pool = modelsFor(configs, s.engine)
  const selected = effectiveConfig(configs, s.engine, s.selectedId)
  const scopeCount = s.allPapers ? s.candidates.length : s.currentUndecided ? 1 : 0
  const currentPaper = project.papers.find((p) => p.id === currentPaperId)
  const checked = s.rows.filter((r) => r.checked).length
  const excludeCount = s.rows.filter((r) => r.proposal.decision === 'Exclude').length
  const openSettings = () => useAiStore.getState().setSettingsOpen(true)

  return (
    <div className="modal-overlay" onClick={() => s.closeDialog()}>
      <div
        className="modal ai-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Screen with AI"
      >
        <div className="modal-head">
          <strong>Screen with AI</strong>
          <button type="button" className="icon-btn" onClick={() => s.closeDialog()} title="Close" aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {s.phase === 'setup' && (
            <>
              <div className="ai-label">What</div>
              <p className="ai-scope">
                {s.allPapers ? (
                  <>
                    Screening <strong>{s.candidates.length} undecided paper{s.candidates.length === 1 ? '' : 's'}</strong>.
                  </>
                ) : (
                  <>
                    Screening the current paper only: <strong>{currentPaper?.title ?? '—'}</strong>
                  </>
                )}
              </p>
              {!s.allPapers && !s.currentUndecided && (
                <p className="ai-note">This paper already has a decision in this seat — nothing to propose.</p>
              )}
              <label className="ai-toggle-row">
                <input
                  type="checkbox"
                  checked={s.allPapers}
                  onChange={(e) => (e.target.checked ? setPendingAll(true) : (s.setAllPapers(false), setPendingAll(false)))}
                />
                Screen all undecided papers
              </label>
              {pendingAll && !s.allPapers && (
                <div className="ai-confirm">
                  <p className="ai-note">{allPapersWarning(s.candidates.length)}</p>
                  <div className="ai-foot">
                    <button type="button" onClick={() => setPendingAll(false)}>
                      Current paper only
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={s.candidates.length === 0}
                      onClick={() => {
                        s.setAllPapers(true)
                        setPendingAll(false)
                      }}
                    >
                      Screen all {s.candidates.length} papers
                    </button>
                  </div>
                </div>
              )}
              {s.allPapers && <p className="ai-note">{allPapersWarning(s.candidates.length)}</p>}
              <p className="ai-note">
                Papers without an abstract are read from the first pages of their PDF; with neither they are skipped.
              </p>

              <div className="ai-label" id="ais-engine-label">
                How
              </div>
              <div className="ai-mode-row" role="radiogroup" aria-labelledby="ais-engine-label">
                <label>
                  <input type="radio" name="ais-engine" checked={s.engine === 'prompt'} onChange={() => s.setEngine('prompt')} />
                  Prompt
                </label>
                <label
                  title={
                    configs.some((c) => c.provider === 'systemone')
                      ? undefined
                      : 'Add a System One model in AI models settings to enable Classify.'
                  }
                >
                  <input
                    type="radio"
                    name="ais-engine"
                    checked={s.engine === 'classify'}
                    disabled={!configs.some((c) => c.provider === 'systemone')}
                    onChange={() => s.setEngine('classify')}
                  />
                  Classify
                </label>
              </div>
              <p className="ai-note">{ENGINE_INFO[s.engine]}</p>

              <div className="ai-label" id="ais-model-label">
                Model
              </div>
              {pool.length === 0 ? (
                <div className="ai-empty-configs">
                  <p>No suitable AI model is set up yet.</p>
                  <button type="button" className="primary" onClick={openSettings}>
                    Set up a model…
                  </button>
                </div>
              ) : (
                <div className="ai-target-row" role="group" aria-labelledby="ais-model-label">
                  <ComboBox
                    value={selected?.id ?? null}
                    options={pool.map(modelOption)}
                    onChange={(id) => {
                      if (id) s.selectConfig(id)
                    }}
                  />
                  <button type="button" className="icon-btn" onClick={openSettings} title="AI models" aria-label="AI models">
                    ⚙
                  </button>
                </div>
              )}

              {s.targetSeat && project.reviewers > 1 && (
                <p className="ai-note">
                  Decisions go into <strong>{seatLabel(project, s.targetSeat)}</strong>.
                </p>
              )}

              <p className="ai-consent">
                {selected ? (
                  <>
                    The title, authors and abstract (or an excerpt of the PDF) of {s.allPapers ? 'each paper' : 'this paper'} will be
                    sent to <strong>{PROVIDERS[selected.provider].label}</strong> ({selected.model}). It leaves this machine.
                    Nothing is written into the project until you press Apply.
                  </>
                ) : (
                  'Nothing is sent until you choose a model and press Start.'
                )}
              </p>

              <details className="ai-prompt">
                <summary>Options</summary>
                {s.allPapers && (
                  <div className="ai-target-row">
                    <label htmlFor="ais-concurrency">Papers at once</label>
                    <select
                      id="ais-concurrency"
                      value={s.concurrency}
                      onChange={(e) => s.setConcurrency(Number(e.target.value))}
                      title="More at once is faster, but hits your provider's rate limits sooner."
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="ai-target-row">
                  <label htmlFor="ais-threshold">Pre-tick Includes at confidence ≥</label>
                  <input
                    id="ais-threshold"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={s.threshold}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (n >= 0 && n <= 1) s.setThreshold(n)
                    }}
                  />
                </div>
              </details>

              <div className="ai-foot">
                <button type="button" onClick={() => s.closeDialog()}>
                  Close
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!selected || scopeCount === 0}
                  onClick={() => void s.run()}
                  title={!selected ? 'Choose a model first' : scopeCount === 0 ? 'No undecided paper in scope' : 'Send the request(s)'}
                >
                  Start
                </button>
              </div>
            </>
          )}

          {s.phase === 'running' && (
            <>
              <div className="ai-running" role="status">
                <Spinner />
                <span className="ai-phase">Screening…</span>
              </div>
              <p className="ai-note">
                {s.done} of {s.total} done
              </p>
              {s.retryNotice && <p className="ai-note ai-retry">{s.retryNotice}</p>}
              <div className="ai-foot">
                <button type="button" onClick={() => s.cancel()} title="Stop; papers that finished stay available for review">
                  Cancel
                </button>
              </div>
            </>
          )}

          {s.phase === 'review' && (
            <>
              <Notes label="failed" items={s.errors} />
              <Notes label="skipped" items={s.skipped} />
              {s.rows.length === 0 ? (
                <>
                  <p>The model proposed no decisions.</p>
                  <div className="ai-foot">
                    <button type="button" className="primary" onClick={() => s.closeDialog()}>
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="ai-note">
                    Exclude proposals never start ticked; Include proposals start ticked only at confidence ≥ {s.threshold}.
                    A tick writes the decision only if the paper is still undecided.
                  </p>
                  <div className="ai-review-head">
                    <div className="ai-select-all">
                      <button type="button" onClick={() => s.setAllChecked(true)}>
                        Select all
                      </button>
                      <button type="button" onClick={() => s.setAllChecked(false)}>
                        Select none
                      </button>
                    </div>
                    <span className="ai-count">
                      {checked} of {s.rows.length} selected · {excludeCount} Exclude
                    </span>
                  </div>
                  <div className="ai-table-wrap">
                    <table className="ai-table">
                      <thead>
                        <tr>
                          <th scope="col" className="ai-col-check">
                            <span className="ai-sr-only">Apply</span>
                          </th>
                          <th scope="col">Paper</th>
                          <th scope="col">Proposed</th>
                          <th scope="col">Justification</th>
                          <th scope="col">Engine</th>
                          <th scope="col" className="ai-col-conf">
                            Confidence
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.rows.map((r) => (
                          <tr key={r.paperId}>
                            <td className="ai-col-check">
                              <input
                                type="checkbox"
                                checked={r.checked}
                                onChange={() => s.toggleRow(r.paperId)}
                                aria-label={`Apply ${r.proposal.decision} to ${r.paperTitle}`}
                              />
                            </td>
                            <td>{r.paperTitle}</td>
                            <td>
                              <strong className={r.proposal.decision === 'Exclude' ? 'ai-screen-exclude' : undefined}>
                                {r.proposal.decision}
                              </strong>
                              {r.proposal.reason && <div className="ai-note">{r.proposal.reason}</div>}
                            </td>
                            <td>
                              {r.proposal.justification && <div>{r.proposal.justification}</div>}
                              {r.proposal.evidence && (
                                <div className="ai-evidence">
                                  <q>{r.proposal.evidence}</q>
                                </div>
                              )}
                            </td>
                            <td>{r.engine === 'classify' ? 'Classify' : 'Prompt'}</td>
                            <td className="ai-col-conf">
                              {r.proposal.confidence === null ? '—' : r.proposal.confidence.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {s.usage.calls > 0 && (
                    <p className="ai-note ai-usage">
                      {s.usage.calls} request{s.usage.calls === 1 ? '' : 's'} · {s.usage.inputTokens} input / {s.usage.outputTokens}{' '}
                      output tokens{s.cost !== null && ` · ≈ $${s.cost.toFixed(2)}`}
                    </p>
                  )}
                  <div className="ai-foot">
                    <button type="button" onClick={() => s.closeDialog()} title="Discard all proposals without applying them">
                      Discard
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={checked === 0}
                      onClick={() => s.apply()}
                      title={checked === 0 ? 'Select at least one proposal to apply' : `Apply ${checked} selected decision${checked === 1 ? '' : 's'}`}
                    >
                      Apply {checked}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {s.phase === 'applied' && s.applied && (
            <>
              <p>
                Recorded {s.applied.written} decision{s.applied.written === 1 ? '' : 's'}, marked as AI-written.
                {s.applied.skipped > 0 && ` ${s.applied.skipped} not written (already decided).`}
              </p>
              <p className="ai-note">One undo step reverts the whole batch.</p>
              <div className="ai-foot">
                <button type="button" className="primary" onClick={() => s.closeDialog()}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

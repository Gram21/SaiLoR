import { useEffect } from 'react'
import { useAiStore } from '../state/aiStore'
import { PROVIDERS } from '../llm/providers'
import { displayPath, parsePath } from '../llm/paths'
import type { LlmAnswer, LlmConfig } from '../llm/types'
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

export function AiDialog() {
  const open = useAiStore((s) => s.open)
  const configs = useAiStore((s) => s.configs)
  const selectedId = useAiStore((s) => s.selectedId)
  const phase = useAiStore((s) => s.phase)
  const error = useAiStore((s) => s.error)
  const elapsed = useAiStore((s) => s.elapsed)
  const targets = useAiStore((s) => s.targets)
  const answer = useAiStore((s) => s.answer)
  const rows = useAiStore((s) => s.rows)
  const applied = useAiStore((s) => s.applied)
  const scanned = useAiStore((s) => s.scanned)

  const closeDialog = useAiStore((s) => s.closeDialog)
  const setSettingsOpen = useAiStore((s) => s.setSettingsOpen)
  const selectConfig = useAiStore((s) => s.selectConfig)
  const run = useAiStore((s) => s.run)
  const cancel = useAiStore((s) => s.cancel)
  const toggleRow = useAiStore((s) => s.toggleRow)
  const setAllRows = useAiStore((s) => s.setAllRows)
  const apply = useAiStore((s) => s.apply)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closeDialog])

  if (!open) return null

  const selected = configs.find((c) => c.id === selectedId) ?? null
  const checkedCount = rows.filter((r) => r.checked).length
  const running = phase === 'reading' || phase === 'calling' || phase === 'parsing'

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
                  <button type="button" className="primary" onClick={() => setSettingsOpen(true)}>
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

              <p className="ai-consent">
                {selected ? (
                  <>
                    {deliveryOf(selected) === 'pdf'
                      ? 'This paper’s PDF file will be sent to '
                      : 'The text of this paper will be extracted and sent to '}
                    <strong>{PROVIDERS[selected.provider].label}</strong> ({selected.model}). It
                    leaves this machine. Nothing is written into the project until you press Apply.
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
                  <summary>Show the prompt</summary>
                  <p className="ai-note">
                    The prompt itself is assembled when you press Start, because it embeds the
                    paper’s text. These are the fields the model will be asked about:
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
                <button type="button" onClick={() => closeDialog()}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void run()}
                  disabled={!selected || targets.length === 0}
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
              <p className="ai-note">
                This can take a minute on a long paper. You can cancel at any time.
              </p>
              <div className="ai-foot">
                <button type="button" onClick={() => cancel()}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {phase === 'review' && answer && (
            <>
              {rows.length === 0 ? (
                <>
                  <p>The model proposed no values.</p>
                  <ReviewNotes answer={answer} />
                  <div className="ai-foot">
                    <button type="button" className="primary" onClick={() => closeDialog()}>
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="ai-review-head">
                    <div className="ai-select-all">
                      <button type="button" onClick={() => setAllRows(true)}>
                        Select all
                      </button>
                      <button type="button" onClick={() => setAllRows(false)}>
                        Select none
                      </button>
                    </div>
                    <span className="ai-count">
                      {checkedCount} of {rows.length} selected
                    </span>
                  </div>

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
                          <th scope="col" className="ai-col-conf">
                            Confidence
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, i) => {
                          const label = pathLabel(row.suggestion.path)
                          return (
                            <tr key={`${row.suggestion.path}-${i}`}>
                              <td className="ai-col-check">
                                <input
                                  type="checkbox"
                                  checked={row.checked}
                                  onChange={(e) => toggleRow(i, e.target.checked)}
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
                                  <q>{row.suggestion.evidence}</q>
                                ) : (
                                  <span className="ai-dash">no quote given</span>
                                )}
                              </td>
                              <td className="ai-col-conf">
                                {confidenceLabel(row.suggestion.confidence)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <ReviewNotes answer={answer} />

                  <div className="ai-foot">
                    <button type="button" onClick={() => closeDialog()}>
                      Discard
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => apply()}
                      disabled={checkedCount === 0}
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
                Filled {applied.filled} field{applied.filled === 1 ? '' : 's'}.
                {applied.skipped > 0 && ` ${applied.skipped} were skipped.`}
              </p>
              {applied.skipped > 0 && (
                <p className="ai-note">
                  A proposal is skipped when the field is no longer empty or its path no longer
                  exists in the schema.
                </p>
              )}
              <p className="ai-note">
                Everything was written as a single change: <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+
                <kbd>Z</kbd> undoes the whole fill in one step.
              </p>
              <div className="ai-foot">
                <button type="button" className="primary" onClick={() => closeDialog()}>
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
                <button type="button" onClick={() => closeDialog()}>
                  Close
                </button>
                {!scanned && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void run()}
                    disabled={!selected || targets.length === 0}
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

/**
 * What the model did *not* give us. The rejected list is deliberately not hidden
 * behind a soft word: it means the model said something the app refused to write.
 */
function ReviewNotes({ answer }: { answer: LlmAnswer }) {
  return (
    <>
      {answer.skipped.length > 0 && (
        <details className="ai-notes">
          <summary>
            The model left {answer.skipped.length} field{answer.skipped.length === 1 ? '' : 's'}{' '}
            empty
          </summary>
          <ul className="ai-note-list">
            {answer.skipped.map((s, i) => (
              <li key={`${s.path}-${i}`}>
                <span className="ai-field-path">{pathLabel(s.path)}</span>
                <span className="ai-note-reason">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {answer.rejected.length > 0 && (
        <details className="ai-notes ai-notes-rejected">
          <summary>
            {answer.rejected.length} proposal{answer.rejected.length === 1 ? ' was' : 's were'}{' '}
            rejected
          </summary>
          <p className="ai-note">
            These came back from the model but did not fit the schema, so they were never offered.
          </p>
          <ul className="ai-note-list">
            {answer.rejected.map((r, i) => (
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

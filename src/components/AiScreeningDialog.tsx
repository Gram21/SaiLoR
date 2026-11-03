// [impl->req~llm-630~1]
// [impl->req~llm-640~1]
// [impl->req~llm-741~1]
// [impl->req~llm-750~1]
// [impl->req~scr-390~1]
import { useEffect, useState } from 'react'
import {
  useAiScreeningStore,
  effectiveConfig,
  modelsFor,
  type ScreeningEngine,
  type ScreeningNote,
} from '../state/aiScreeningStore'
import { useAiStore, destinationNote, isLocalModel, startBlocker } from '../state/aiStore'
import { useStore } from '../state/store'
import { seatLabel } from '../model/project'
import { PROVIDERS } from '../llm/providers'
import type { LlmConfig } from '../llm/types'
import { ComboBox } from './ComboBox'
import { Spinner } from './Spinner'
import { AiPreviewNotice } from './AiPreviewNotice'
import { useT, t, tp, rich, type MessageKey, type PluralKey } from '../i18n'
import '../styles/ai.css'

/**
 * The AI-assisted screening dialog: a view over `useAiScreeningStore`. Nothing
 * is sent until Start, nothing is written until Apply, and Exclude proposals
 * never start ticked (a wrongly excluded paper silently leaves the review).
 */

const ENGINE_INFO: Record<ScreeningEngine, MessageKey> = {
  prompt: 'ai.screening.engine.prompt',
  classify: 'ai.screening.engine.classify',
}

function modelOption(c: LlmConfig): { id: string; label: string } {
  return { id: c.id, label: `${c.name} — ${PROVIDERS[c.provider].label} · ${c.model}` }
}

function allPapersWarning(count: number, local: boolean): string {
  return t('ai.screening.allWarning', {
    papers: tp('ai.papers.count', count),
    location: t(local ? 'ai.screening.stayLocal' : 'ai.screening.leaveLocal'),
  })
}

function Notes({ summary, items }: { summary: PluralKey; items: ScreeningNote[] }) {
  useT()
  if (items.length === 0) return null
  return (
    <details className="ai-notes ai-notes-rejected">
      <summary>
        {tp(summary, items.length)}
      </summary>
      <ul className="ai-note-list">
        {items.map((e, i) => (
          <li key={`${e.paperId}-${i}`}>
            <span className="ai-field-path">{e.paperTitle}</span>
            <span className="ai-note-reason">{e.message}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function AiScreeningDialog() {
  const t = useT()
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
  const blocker = selected && s.engine === 'prompt' ? startBlocker('prompt', selected) : null
  const openSettings = () => useAiStore.getState().setSettingsOpen(true)

  return (
    <div className="modal-overlay" onClick={() => s.closeDialog()}>
      <div
        className="modal ai-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('ai.screening.dialogTitle')}
      >
        <div className="modal-head">
          <strong>{t('ai.screening.dialogTitle')}</strong>
          <button type="button" className="icon-btn" onClick={() => s.closeDialog()} title={t('common.close')} aria-label={t('common.close')}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <AiPreviewNotice />
          {s.phase === 'setup' && (
            <>
              <div className="ai-label">{t('ai.section.what')}</div>
              <p className="ai-scope">
                {s.allPapers
                  ? rich('ai.screening.scopeAll', { papers: tp('ai.screening.undecided', s.candidates.length) })
                  : rich('ai.screening.scopeCurrent', { title: currentPaper?.title ?? '—' })}
              </p>
              {!s.allPapers && !s.currentUndecided && (
                <p className="ai-note">{t('ai.screening.decided')}</p>
              )}
              <label className="ai-toggle-row">
                <input
                  type="checkbox"
                  checked={s.allPapers}
                  onChange={(e) => (e.target.checked ? setPendingAll(true) : (s.setAllPapers(false), setPendingAll(false)))}
                />
                {t('ai.screening.allUndecided')}
              </label>
              {pendingAll && !s.allPapers && (
                <div className="ai-confirm">
                  <p className="ai-note">{allPapersWarning(s.candidates.length, !!selected && isLocalModel(selected))}</p>
                  <div className="ai-foot">
                    <button type="button" onClick={() => setPendingAll(false)}>
                      {t('ai.action.currentOnly')}
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
                      {t('ai.screening.screenAll', { count: s.candidates.length })}
                    </button>
                  </div>
                </div>
              )}
              {s.allPapers && <p className="ai-note">{allPapersWarning(s.candidates.length, !!selected && isLocalModel(selected))}</p>}
              <p className="ai-note">
                {t('ai.screening.noAbstract')}
              </p>

              <div className="ai-label" id="ais-engine-label">
                {t('ai.section.how')}
              </div>
              <div className="ai-mode-row" role="radiogroup" aria-labelledby="ais-engine-label">
                <label>
                  <input type="radio" name="ais-engine" checked={s.engine === 'prompt'} onChange={() => s.setEngine('prompt')} />
                  {t('ai.mode.prompt')}
                </label>
                <label
                  title={
                    configs.some((c) => c.provider === 'systemone')
                      ? undefined
                      : t('ai.screening.classifyHint')
                  }
                >
                  <input
                    type="radio"
                    name="ais-engine"
                    checked={s.engine === 'classify'}
                    disabled={!configs.some((c) => c.provider === 'systemone')}
                    onChange={() => s.setEngine('classify')}
                  />
                  {t('ai.mode.classify')}
                </label>
              </div>
              <p className="ai-note">{t(ENGINE_INFO[s.engine])}</p>

              <div className="ai-label" id="ais-model-label">
                {t('ai.section.model')}
              </div>
              {pool.length === 0 ? (
                <div className="ai-empty-configs">
                  <p>{t('ai.screening.noModel')}</p>
                  <button type="button" className="primary" onClick={openSettings}>
                    {t('ai.action.setUp')}
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
                  <button type="button" className="icon-btn" onClick={openSettings} title={t('ai.models.title')} aria-label={t('ai.models.title')}>
                    ⚙
                  </button>
                </div>
              )}

              {s.targetSeat && project.reviewers > 1 && (
                <p className="ai-note">
                  {rich('ai.screening.seat', { seat: seatLabel(project, s.targetSeat) })}
                </p>
              )}

              <p className="ai-consent">
                {selected ? (
                  rich('ai.screening.consent', {
                    scope: t(s.allPapers ? 'ai.consent.scopeEach' : 'ai.consent.scopeThis'),
                    provider: PROVIDERS[selected.provider].label,
                    model: selected.model,
                    destination: destinationNote(selected),
                  })
                ) : (
                  t('ai.screening.nothingSent')
                )}
              </p>

              {blocker && <p className="ai-note ai-error">{blocker}</p>}

              <details className="ai-prompt">
                <summary>{t('ai.options.summary')}</summary>
                {s.allPapers && (
                  <div className="ai-target-row">
                    <label htmlFor="ais-concurrency">{t('ai.concurrency.label')}</label>
                    <select
                      id="ais-concurrency"
                      value={s.concurrency}
                      onChange={(e) => s.setConcurrency(Number(e.target.value))}
                      title={t('ai.screening.concurrencyTitle')}
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
                  <label htmlFor="ais-threshold">{t('ai.screening.threshold')}</label>
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
                  {t('common.close')}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!selected || scopeCount === 0 || !!blocker}
                  onClick={() => void s.run()}
                  title={blocker ?? (!selected ? t('ai.screening.chooseModel') : scopeCount === 0 ? t('ai.screening.noUndecided') : t('ai.screening.sendRequests'))}
                >
                  {t('ai.action.start')}
                </button>
              </div>
            </>
          )}

          {s.phase === 'running' && (
            <>
              <div className="ai-running" role="status">
                <Spinner />
                <span className="ai-phase">{s.startNotice ?? t('ai.screening.running')}</span>
              </div>
              <p className="ai-note">
                {t('ai.screening.progress', { done: s.done, total: s.total })}
              </p>
              {s.retryNotice && <p className="ai-note ai-retry">{s.retryNotice}</p>}
              <div className="ai-foot">
                <button type="button" onClick={() => s.cancel()} title={t('ai.screening.cancelTitle')}>
                  {t('common.cancel')}
                </button>
              </div>
            </>
          )}

          {s.phase === 'review' && (
            <>
              <Notes summary="ai.runErrors.failed" items={s.errors} />
              <Notes summary="ai.screening.skipped" items={s.skipped} />
              <Notes summary="ai.screening.withNotes" items={s.infos} />
              {s.rows.length === 0 ? (
                <>
                  <p>{t('ai.screening.noDecisions')}</p>
                  <div className="ai-foot">
                    <button type="button" className="primary" onClick={() => s.closeDialog()}>
                      {t('common.close')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="ai-note">{t('ai.screening.explain', { threshold: s.threshold })}</p>
                  <div className="ai-review-head">
                    <div className="ai-select-all">
                      <button type="button" onClick={() => s.setAllChecked(true)}>
                        {t('ai.action.selectAll')}
                      </button>
                      <button type="button" onClick={() => s.setAllChecked(false)}>
                        {t('ai.action.selectNone')}
                      </button>
                    </div>
                    <span className="ai-count">
                      {t('ai.screening.excludeCount', { checked, total: s.rows.length, excluded: excludeCount })}
                    </span>
                  </div>
                  <div className="ai-table-wrap">
                    <table className="ai-table">
                      <thead>
                        <tr>
                          <th scope="col" className="ai-col-check">
                            <span className="ai-sr-only">{t('common.apply')}</span>
                          </th>
                          <th scope="col">{t('ai.table.paper')}</th>
                          <th scope="col">{t('ai.screening.proposed')}</th>
                          <th scope="col">{t('ai.screening.justification')}</th>
                          <th scope="col">{t('ai.screening.engine')}</th>
                          <th scope="col" className="ai-col-conf">
                            {t('ai.table.confidence')}
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
                                aria-label={t('ai.screening.applyFor', { decision: r.proposal.decision, paper: r.paperTitle })}
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
                            <td>{t(r.engine === 'classify' ? 'ai.mode.classify' : 'ai.mode.prompt')}</td>
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
                      {tp('ai.usage.requests', s.usage.calls)} · {t('ai.usage.tokens', { input: s.usage.inputTokens, output: s.usage.outputTokens })}{s.cost !== null && ` · ≈ $${s.cost.toFixed(2)}`}
                    </p>
                  )}
                  <div className="ai-foot">
                    <button type="button" onClick={() => s.closeDialog()} title={t('ai.review.discardTitle')}>
                      {t('ai.action.discard')}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={checked === 0}
                      onClick={() => s.apply()}
                      title={checked === 0 ? t('ai.review.applyNone') : tp('ai.screening.applyCount', checked)}
                    >
                      {t('ai.review.applyButton', { count: checked })}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {s.phase === 'applied' && s.applied && (
            <>
              <p>
                {tp('ai.screening.recorded', s.applied.written)}
                {s.applied.skipped > 0 && ` ${t('ai.screening.notWritten', { count: s.applied.skipped })}`}
              </p>
              <p className="ai-note">{t('ai.screening.undoOne')}</p>
              <div className="ai-foot">
                <button type="button" className="primary" onClick={() => s.closeDialog()}>
                  {t('common.close')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// [impl->req~llm-830~1]
// [impl->req~llm-831~1]
// [impl->req~llm-832~1]
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { getPlatform } from '../platform'
import { agreePercent, evaluateAi, evaluationCsv } from '../llm/evaluation'
import { useT } from '../i18n'
import '../styles/ai.css'
import { Modal } from './Modal'

export function AiEvaluationDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const t = useT()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const evaluation = useMemo(() => (project ? evaluateAi(project) : null), [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!project || !evaluation) return null

  const runExport = async () => {
    const platform = getPlatform()
    try {
      const path = await platform.pickTextExportPath('ai-evaluation.csv', 'csv')
      if (!path) return
      const res = await platform.writeTextFile(path, evaluationCsv(evaluation.fields))
      setMessage(
        res.ok
          ? { ok: true, text: t('app.export.saved', { path: res.path }) }
          : { ok: false, text: t('app.export.saveFailed', { error: res.error }) },
      )
    } catch (err) {
      setMessage({ ok: false, text: t('app.export.saveFailed', { error: String(err) }) })
    }
  }

  const empty = evaluation.seat === null ? t('aiEval.noSeat') : evaluation.papers === 0 ? t('aiEval.empty') : null

  return (
    <Modal onClose={onClose} aria-label={t('aiEval.title')}>
      <div className="modal-head">
        <strong>{t('aiEval.title')}</strong>
        <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      <div className="modal-body">
        {empty ? (
          <p>{empty}</p>
        ) : (
          <>
            <p>{t('aiEval.intro', { count: evaluation.papers })}</p>
            <p>{t('aiEval.models')}</p>
            <div className="agreement-perfield-scroll">
              <table className="agreement-perfield-table">
                <thead>
                  <tr>
                    <th>{t('consolidation.agreement.field')}</th>
                    <th>{t('aiEval.compared')}</th>
                    <th>{t('aiEval.agree')}</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluation.fields.map((f) => (
                    <tr key={f.key}>
                      <td>{f.label}</td>
                      <td>{f.compared}</td>
                      <td>{f.compared === 0 ? '—' : `${agreePercent(f)} %`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {message && <p className={message.ok ? undefined : 'ai-error'}>{message.text}</p>}
        <div className="screening-import-actions">
          <button type="button" onClick={onClose}>
            {t('common.close')}
          </button>
          {!empty && (
            <button type="button" className="primary" onClick={() => void runExport()}>
              {t('aiEval.export')}
            </button>
          )}
        </div>
      </div>
      
    </Modal>
  )
}

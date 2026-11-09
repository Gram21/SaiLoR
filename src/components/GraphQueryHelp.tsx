// [impl->req~ui-400~1]
import { useEffect } from 'react'
import { useT } from '../i18n'
import { Modal } from './Modal'

const TEXT_EXAMPLES = [
  ['Turing', 'graphView.helpEx.word'],
  ['"deep learning" type:paper', 'graphView.helpEx.phrase'],
  ['Method=Survey', 'graphView.helpEx.answer'],
  ['type:paper -keyword:bias depth:2', 'graphView.helpEx.exclude'],
] as const

const CYPHER_EXAMPLES = [
  ['MATCH (p:Paper) RETURN p LIMIT 20', 'graphView.helpEx.cypherAll'],
  ["MATCH (p:Paper)-[:authoredBy]->(a:Author) WHERE a.label CONTAINS 'Turing' RETURN p, a", 'graphView.helpEx.cypherAuthor'],
  ['MATCH (p:Paper) RETURN p.year AS year, count(*)', 'graphView.helpEx.cypherCount'],
] as const

/** Explains the two query languages of the graph view with examples. */
export function GraphQueryHelp({ onClose }: { onClose: () => void }) {
  const t = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const list = (rows: readonly (readonly [string, Parameters<typeof t>[0]])[]) => (
    <dl className="graph-help-examples">
      {rows.map(([code, key]) => (
        <div key={code}>
          <dt>
            <code>{code}</code>
          </dt>
          <dd>{t(key)}</dd>
        </div>
      ))}
    </dl>
  )

  return (
    <Modal onClose={onClose} aria-label={t('graphView.helpTitle')}>
      <div className="modal-head">
        <strong>{t('graphView.helpTitle')}</strong>
      </div>
      <div className="modal-body">
        <h3>{t('graphView.lang.text')}</h3>
        <p>{t('graphView.helpText')}</p>
        {list(TEXT_EXAMPLES)}
        <h3>{t('graphView.lang.cypher')}</h3>
        <p>{t('graphView.helpCypher')}</p>
        {list(CYPHER_EXAMPLES)}
        <p>{t('graphView.helpKeys')}</p>
        <div className="screening-import-actions">
          <button type="button" className="primary" onClick={onClose} autoFocus>
            {t('common.close')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

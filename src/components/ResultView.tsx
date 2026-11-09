// [impl->req~ui-270~1]
import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { Modal } from './Modal'
import { GraphView } from './GraphView'
import { DiagramView } from './DiagramView'
import type { DiagramConfig } from '../model/diagram'
import { loadDiagramConfig, saveDiagramConfig } from '../state/resultSettings'

export type ResultTab = 'graph' | 'diagram'
const TABS: ResultTab[] = ['graph', 'diagram']

/** The result view: one window with the knowledge graph and the diagrams as tabs. */
export function ResultView({ initial = 'graph', onClose }: { initial?: ResultTab; onClose: () => void }) {
  const t = useT()
  const [tab, setTab] = useState<ResultTab>(initial)
  const [diagram, setDiagram] = useState<DiagramConfig>(loadDiagramConfig)
  useEffect(() => saveDiagramConfig(diagram), [diagram])
  return (
    <Modal className="graph-view result-view" aria-label={t('resultView.title')}>
      <div className="modal-head result-head">
        <strong>{t('resultView.title')}</strong>
        <div className="result-tabs" role="tablist" aria-label={t('resultView.tabs')}>
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {t(`resultView.tab.${id}` as const)}
            </button>
          ))}
        </div>
        <div className="modal-head-actions">
          <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
      </div>
      {tab === 'graph' ? <GraphView onClose={onClose} /> : <DiagramView config={diagram} setConfig={setDiagram} onClose={onClose} />}
    </Modal>
  )
}

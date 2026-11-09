// [impl->req~ui-370~1]
import { useT } from '../i18n'
import type { FontSearch } from './diagramExport'
import { Modal } from './Modal'

export type FontChoice = 'embed' | 'svg' | null

const SHOWN = 12

/** Asks whether to embed a font in the PDF or to save SVG instead, and says why only SVG is offered when no font can be embedded. */
export function PdfFontDialog({ chars, search, onChoose }: { chars: string[]; search: FontSearch; onChoose: (choice: FontChoice) => void }) {
  const t = useT()
  const list = (all: string[]) => all.slice(0, SHOWN).join(' ') + (all.length > SHOWN ? ' …' : '')
  const found = 'found' in search ? search.found : null
  return (
    <Modal onClose={() => onChoose(null)} aria-label={t('diagram.font.title')}>
      <div className="modal-head">
        <strong>{t('diagram.font.title')}</strong>
      </div>
      <div className="modal-body">
        <p>{t('diagram.font.intro', { chars: list(chars) })}</p>
        {found ? (
          <>
            <p>{t('diagram.font.embedOffer')}</p>
            <p>{t('diagram.font.svgOffer')}</p>
          </>
        ) : (
          <>
            <p>{t('diagram.font.onlySvg')}</p>
            <p role="note">
              {search.why === 'shaping'
                ? t('diagram.font.shaping')
                : search.why === 'no-font'
                  ? t('diagram.font.noFont')
                  : t('diagram.font.uncovered', { chars: list(search.missing) })}
            </p>
          </>
        )}
        <div className="screening-import-actions">
          <button type="button" onClick={() => onChoose(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className={found ? undefined : 'primary'} onClick={() => onChoose('svg')}>
            {t('diagram.font.svg')}
          </button>
          {found && (
            <button type="button" className="primary" onClick={() => onChoose('embed')}>
              {t('diagram.font.embed')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

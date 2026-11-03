import { STRICT_MANAGER, consolidationGateMissing, useStore } from '../state/store'
import { useT } from '../i18n'

// [impl->req~con-500~1]
// [impl->req~con-510~1]
/** Shown instead of the Consolidation form while assigned persons have not finished the paper. */
export function StrictGate() {
  const missing = useStore((s) => consolidationGateMissing(s).map((p) => p.name).join(', '))
  const paperId = useStore((s) => s.currentPaperId)
  const manager = useStore((s) => s.strictPerson === STRICT_MANAGER)
  const override = useStore((s) => s.overrideConsolidationGate)
  const t = useT()
  if (!missing || !paperId) return null

  const openAnyway = () => {
    const message = t('strict.gate.confirm', { names: missing })
    if (window.confirm(message)) override(paperId)
  }

  return (
    <div className="panel annotations empty" role="status">
      <p>{t('strict.gate.body')}</p>
      <p>{t('strict.gate.missing', { names: missing })}</p>
      {manager && (
        <button type="button" onClick={openAnyway}>
          {t('strict.gate.openAnyway')}
        </button>
      )}
    </div>
  )
}

import { STRICT_MANAGER, consolidationGateMissing, useStore } from '../state/store'

// [impl->req~con-500~1]
// [impl->req~con-510~1]
/** Shown instead of the Consolidation form while assigned persons have not finished the paper. */
export function StrictGate() {
  const missing = useStore((s) => consolidationGateMissing(s).map((p) => p.name).join(', '))
  const paperId = useStore((s) => s.currentPaperId)
  const manager = useStore((s) => s.strictPerson === STRICT_MANAGER)
  const override = useStore((s) => s.overrideConsolidationGate)
  if (!missing || !paperId) return null

  const openAnyway = () => {
    const message = `These persons have not finished this paper: ${missing}. Open Consolidation anyway?`
    if (window.confirm(message)) override(paperId)
  }

  return (
    <div className="panel annotations empty" role="status">
      <p>Consolidation opens when all assigned persons have finished this paper.</p>
      <p>Not finished yet: {missing}</p>
      {manager && (
        <button type="button" onClick={openAnyway}>
          Open anyway
        </button>
      )}
    </div>
  )
}

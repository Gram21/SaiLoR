import { STRICT_MANAGER, useStore } from '../state/store'
import { seatLocked } from '../model/strict'
import { useT } from '../i18n'

// [impl->req~con-550~1]
// [impl->req~con-570~1]
/** Banner over locked strict-mode work, with the Manager's Reopen button. */
export function StrictLockBanner() {
  const paperId = useStore((s) => s.currentPaperId)
  const seat = useStore((s) => s.currentReviewer)
  const locked = useStore((s) => seatLocked(s.project, s.currentPaperId, s.currentReviewer))
  const manager = useStore((s) => s.strictPerson === STRICT_MANAGER && !s.readOnly)
  const reopenSeat = useStore((s) => s.reopenSeat)
  const t = useT()
  if (!locked || !paperId || !seat) return null

  const reopen = () => {
    if (window.confirm(t('strict.lock.reopenConfirm'))) reopenSeat(paperId, seat)
  }

  return (
    <p className="strict-lock-banner" role="status">
      {t('strict.lock.banner')}
      {manager && (
        <button type="button" onClick={reopen}>
          {t('strict.lock.reopen')}
        </button>
      )}
    </p>
  )
}

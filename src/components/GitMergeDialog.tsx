// [impl->req~git-300~1]
import { useT } from '../i18n'
import { useGitStore } from '../state/gitStore'
import { ConflictResolutionDialog } from './ConflictResolutionDialog'

export { isForeignReview } from './ConflictResolutionDialog'

/** The pull / merge-branch / branch-switch conflict dialog. */
export function GitMergeDialog() {
  const t = useT()
  const merge = useGitStore((s) => s.panel?.merge ?? null)
  const resolveConflict = useGitStore((s) => s.resolveConflict)
  const takeAll = useGitStore((s) => s.takeAll)
  const finishMerge = useGitStore((s) => s.finishMerge)
  const cancelMerge = useGitStore((s) => s.cancelMerge)
  const error = useGitStore((s) => s.panel?.error ?? null)
  const dismissPanelMessage = useGitStore((s) => s.dismissPanelMessage)
  if (!merge) return null
  return (
    <ConflictResolutionDialog
      merge={merge}
      labels={{
        title: t('git.mergeDialog.title'),
        intro: t('git.mergeDialog.intro', { ref: merge.ref }),
        theirsValue: t('git.mergeDialog.theirsValue'),
        useAllTheirs: t('git.mergeDialog.useAllTheirs'),
        cancel: t('git.mergeDialog.cancel'),
        cancelTitle: t('git.mergeDialog.cancelTitle'),
        finish: t('git.mergeDialog.finish'),
        finishTitle: t('git.mergeDialog.finishTitle'),
      }}
      error={error}
      onResolve={resolveConflict}
      onTakeAll={takeAll}
      onFinish={() => void finishMerge()}
      onCancel={() => void cancelMerge()}
      onDismissError={dismissPanelMessage}
    />
  )
}

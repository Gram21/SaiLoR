import { useGitStore } from '../state/gitStore'
import { ConflictResolutionDialog } from './ConflictResolutionDialog'

export { isForeignReview } from './ConflictResolutionDialog'

/** The pull / merge-branch / branch-switch conflict dialog. */
export function GitMergeDialog() {
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
        title: 'Resolve merge conflicts',
        intro:
          `Your changes and ${merge.ref}'s both changed these fields. Everything else has already ` +
          "been merged: a field only one side changed kept that side's value.",
        theirsValue: 'the remote value',
        useAllTheirs: 'Use all remote',
        cancel: 'Cancel merge',
        cancelTitle: 'Abort the merge and discard all conflict resolutions',
        finish: 'Finish merge',
        finishTitle: 'Commit the merge with the resolutions chosen above',
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

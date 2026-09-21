import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { alignableNodes } from '../consolidate/align'
import { consolidationMark, markParts } from '../consolidate/readiness'

/**
 * Line a paper's reviewers up while the consolidator looks at it.
 *
 * Runs whenever Consolidation is the active seat, one schema node at a time,
 * yielding to the browser between nodes. Matching is not cheap — a large paper
 * measures in the hundreds of milliseconds (see `TextSimCache`) — and doing it
 * in one blocking pass would freeze the window at the exact moment it opens.
 * Nodes are independent, so splitting the work costs nothing but a few frames.
 *
 * Whatever the reviewer opens the compare popup on jumps the queue: that node
 * is the one whose answer is needed *now*, and the rest of the paper can wait
 * its turn. In the common case the queue is already drained before anyone
 * clicks anything and none of this is visible.
 *
 * None of it runs again while the reviewers' answers are unchanged. Both steps
 * read as harmless repeats — matching is frozen once an answer hangs off a
 * node, and adoption only fills *unanswered* fields — but "unanswered" includes
 * a field the consolidator emptied on purpose, so leaving the seat and coming
 * back used to put the reviewers' value straight back. `Paper.consolidationSync`
 * (see `consolidationMark`) is what makes the repeat visit a no-op instead.
 *
 * When the reviewers *have* changed something and the consolidator has edited
 * the tree since the last run, the choice is not the scheduler's to make: it
 * asks, via `openConsolidationUpdatePrompt`, and runs only if told to. A paper
 * with no recorded mark at all — never consolidated, or saved before this was
 * tracked — is not a conflict, so it just runs.
 */
export function useConsolidationAlignment(): void {
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const target = useStore((s) => s.consolidationTarget)
  const alignConsolidationNode = useStore((s) => s.alignConsolidationNode)
  const adoptUnanimousValues = useStore((s) => s.adoptUnanimousValues)
  const markConsolidationSynced = useStore((s) => s.markConsolidationSynced)
  const openUpdatePrompt = useStore((s) => s.openConsolidationUpdatePrompt)
  const approved = useStore((s) => s.consolidationUpdateApproved)

  // The queue is a ref, not state: `prioritize` reorders it from a second
  // effect, and a re-render for each node would be pure churn.
  const queue = useRef<string[]>([])
  const running = useRef(false)

  const active = currentReviewer === 'consolidation' && !!project && project.reviewers > 1
  const schema = project?.schema

  useEffect(() => {
    if (!active || !currentPaperId || !schema) {
      queue.current = []
      return
    }
    // Read off the store rather than the rendered `project`: this effect must
    // not list `project` as a dependency, or the writes the run itself makes
    // would tear it down and restart it before it ever finished.
    const paper = useStore.getState().project?.papers.find((p) => p.id === currentPaperId)
    if (!paper) {
      queue.current = []
      return
    }

    const mark = consolidationMark(schema, paper)
    const previous = paper.consolidationSync
    if (previous === mark) return
    if (previous !== undefined && approved !== currentPaperId) {
      const before = markParts(previous)
      const now = markParts(mark)
      if (before.reviews === now.reviews) {
        // Only the consolidator's own tree moved. Nothing to re-run — just
        // record where things now stand, so the next visit is a clean no-op.
        markConsolidationSynced(currentPaperId)
        return
      }
      if (before.consolidated !== now.consolidated) {
        openUpdatePrompt(currentPaperId)
        return
      }
    }

    queue.current = alignableNodes(schema)

    let cancelled = false
    // Each paper is one undo entry: the first step that changes anything takes
    // the snapshot, and the rest fold into it.
    let pushedUndo = false
    running.current = true

    const step = () => {
      if (cancelled) return
      const nodeName = queue.current.shift()
      if (nodeName === undefined) {
        // Everything is lined up, so "reviewer 2's entry N" now means the same
        // entry as reviewer 1's — which is the point at which reading across at
        // a fixed index is meaningful, and therefore the earliest this can run.
        adoptUnanimousValues(currentPaperId, pushedUndo)
        // Last, so a run cut short by a seat change leaves the paper stale and
        // is redone rather than recorded as complete.
        markConsolidationSynced(currentPaperId)
        running.current = false
        return
      }
      const changed = alignConsolidationNode(currentPaperId, nodeName, pushedUndo)
      if (changed) pushedUndo = true
      // Back to the event loop between nodes, so typing and scrolling stay
      // responsive while a big paper is still being matched.
      setTimeout(step, 0)
    }
    const handle = setTimeout(step, 0)

    return () => {
      cancelled = true
      running.current = false
      clearTimeout(handle)
    }
  }, [
    active,
    currentPaperId,
    schema,
    approved,
    alignConsolidationNode,
    adoptUnanimousValues,
    markConsolidationSynced,
    openUpdatePrompt,
  ])

  // Pull the node the reviewer just asked about to the front of what is left.
  useEffect(() => {
    if (!target || !running.current) return
    const nodeName = target.path[0]?.name ?? target.name
    const at = queue.current.indexOf(nodeName)
    if (at > 0) {
      queue.current.splice(at, 1)
      queue.current.unshift(nodeName)
    }
  }, [target])
}

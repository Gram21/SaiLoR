import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { alignableNodes } from '../consolidate/align'

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
 */
export function useConsolidationAlignment(): void {
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const target = useStore((s) => s.consolidationTarget)
  const alignConsolidationNode = useStore((s) => s.alignConsolidationNode)

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

    queue.current = alignableNodes(schema)
    if (queue.current.length === 0) return

    let cancelled = false
    // Each paper is one undo entry: the first node that changes anything takes
    // the snapshot, and the rest fold into it.
    let pushedUndo = false
    running.current = true

    const step = () => {
      if (cancelled) return
      const nodeName = queue.current.shift()
      if (nodeName === undefined) {
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
  }, [active, currentPaperId, schema, alignConsolidationNode])

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

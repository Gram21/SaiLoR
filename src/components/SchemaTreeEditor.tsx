import { useMemo, useRef, useState, type DragEvent } from 'react'
import {
  useEditorStore,
  nodePathNames,
  parentUidOf,
  findNode,
  type DropPosition,
  type EditorNode,
  type EditorNodeKind,
} from '../state/editorStore'
import { countPapersUsingField, countLinksUsingField } from '../model/fieldUsage'
import '../styles/schema-editor.css'

/** Where the currently dragged node would land. */
interface DropTarget {
  uid: string
  position: DropPosition
}

const KIND_LABELS: Array<[EditorNodeKind, string]> = [
  ['group', 'Group (no value)'],
  ['string', 'Text'],
  ['number', 'Number'],
  ['year', 'Year'],
  ['boolean', 'Yes/no'],
]

/** Visual editor for the annotation schema: a nested, drag-reorderable field tree. */
export function SchemaTreeEditor() {
  const nodes = useEditorStore((s) => s.nodes)
  const addNode = useEditorStore((s) => s.addNode)

  // Drag state is local: it is transient UI, not part of the saved draft.
  const [dragUid, setDragUid] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  const endDrag = () => {
    setDragUid(null)
    setDropTarget(null)
  }

  // Only clear the indicator if it still points at the row we are leaving: the
  // new row's dragover already fires before the old row's dragleave.
  const leaveRow = (uid: string) =>
    setDropTarget((t) => (t && t.uid === uid ? null : t))

  if (nodes.length === 0) {
    return (
      <div className="schema-editor">
        <div className="schema-empty">
          <p>No fields yet — add one to describe what you want to record per paper.</p>
          <button type="button" className="add-btn" onClick={() => addNode(null)}>
            + Add field
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="schema-editor">
      <div className="schema-tree">
        {nodes.map((node) => (
          <SchemaNodeRow
            key={node.uid}
            node={node}
            ancestors={EMPTY_PATH}
            inDragged={false}
            dragUid={dragUid}
            dropTarget={dropTarget}
            onDragStart={setDragUid}
            onDragEnd={endDrag}
            onDragOverRow={setDropTarget}
            onDragLeaveRow={leaveRow}
          />
        ))}
      </div>
      <button type="button" className="add-btn schema-add-root" onClick={() => addNode(null)}>
        + Add field
      </button>
    </div>
  )
}

/** Stable identity so the root rows don't remount on every render. */
const EMPTY_PATH: string[] = []

interface SchemaNodeRowProps {
  node: EditorNode
  /** Names of this node's ancestors, root first — the answer-tree path to it. */
  ancestors: string[]
  /** True when this row lives inside the subtree being dragged (an illegal drop). */
  inDragged: boolean
  dragUid: string | null
  dropTarget: DropTarget | null
  onDragStart: (uid: string) => void
  onDragEnd: () => void
  onDragOverRow: (target: DropTarget) => void
  onDragLeaveRow: (uid: string) => void
}

function SchemaNodeRow({
  node,
  ancestors,
  inDragged,
  dragUid,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDragLeaveRow,
}: SchemaNodeRowProps) {
  const addNode = useEditorStore((s) => s.addNode)
  const updateNode = useEditorStore((s) => s.updateNode)
  const removeNode = useEditorStore((s) => s.removeNode)
  const moveNode = useEditorStore((s) => s.moveNode)
  const toggleCollapsed = useEditorStore((s) => s.toggleCollapsed)
  const papers = useEditorStore((s) => s.papers)

  // The field's name when the input gained focus, so a *committed* rename (on
  // blur) can be checked against what papers actually record — rather than
  // firing a confirm on every keystroke of the edit. Same shape as the
  // screening reasons editor's guard, for the same reason.
  const nameOnFocus = useRef<string | null>(null)

  /**
   * Answers are keyed by field name, and nothing migrates them: renaming or
   * removing a field orphans every answer recorded under it, and the next save
   * makes that permanent. Warn before it happens — the screening reasons
   * editor has guarded the identical hazard from the start; the schema editor
   * never did.
   */
  const confirmDestructive = (what: 'rename' | 'remove', ...names: (string | null)[]): boolean => {
    // Several candidate names, because a rename may be typed but not yet
    // committed: clicking a <button> does not move focus on macOS/Chromium, so
    // pressing × right after retyping the name never fires the input's blur.
    // Checking only the live name would then find nothing (papers still record
    // the *old* one) and delete the answers with no warning — the same bypass
    // that made this guard necessary in the first place.
    const candidates = [...new Set(names.filter((n): n is string => !!n))]
    let worst = { name: '', count: 0, links: 0 }
    for (const candidate of candidates) {
      const path = [...ancestors, candidate]
      const count = countPapersUsingField(papers, path)
      const links = countLinksUsingField(papers, path)
      if (count + links > worst.count + worst.links) worst = { name: candidate, count, links }
    }
    if (worst.count === 0 && worst.links === 0) return true
    const verb = what === 'rename' ? 'Renaming' : 'Removing'
    const parts: string[] = []
    if (worst.count > 0) {
      parts.push(`${worst.count === 1 ? '1 paper records an answer' : `${worst.count} papers record answers`}`)
    }
    if (worst.links > 0) {
      parts.push(
        `${worst.links === 1 ? '1 paper has a PDF highlight/note linked' : `${worst.links} papers have PDF highlights/notes linked`}`,
      )
    }
    return window.confirm(
      `${parts.join(', and ')} under "${worst.name}". ${verb} it will discard that — including every ` +
        `reviewer's own — the next time the project is saved, and it cannot be undone afterwards.\n\nContinue?`,
    )
  }

  const commitRename = () => {
    const from = nameOnFocus.current
    nameOnFocus.current = null
    if (from === null || from === node.name) return
    if (!confirmDestructive('rename', from)) {
      // Put the old name back — the reviewer declined to lose the answers.
      updateNode(node.uid, { name: from })
    }
  }

  // The row itself carries the drag, but only once the handle is pressed:
  // a permanently draggable row would break text selection inside its inputs.
  const [armed, setArmed] = useState(false)

  const dragging = dragUid === node.uid
  const isSubtree = dragging || inDragged
  const position = dropTarget && dropTarget.uid === node.uid ? dropTarget.position : null

  // Answers nest exactly as the schema does, so a child's path is this node's
  // path plus its own name.
  //
  // These are the *live* names, so an uncommitted rename of a group makes its
  // children's paths miss the answers stored under the old one. That is
  // harmless in practice, and deliberately not worked around: renaming the
  // group is itself guarded, so reaching this state means the reviewer was
  // already warned those answers would be discarded and said yes. A second
  // warning when they then delete a child would be telling them something they
  // have already agreed to. If they declined, the rename is reverted and these
  // paths are correct again.
  const childAncestors = useMemo(() => [...ancestors, node.name], [ancestors, node.name])

  const unbounded = node.max === null
  const hasChildren = node.children.length > 0

  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('text/plain', node.uid)
    e.dataTransfer.effectAllowed = 'move'
    e.stopPropagation()
    onDragStart(node.uid)
  }

  const handleDragEnd = () => {
    setArmed(false)
    onDragEnd()
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    // Not preventing the default marks this row as an invalid drop target, so
    // the cursor already tells the user that self/descendant drops are refused.
    if (!dragUid || isSubtree) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    const next: DropPosition = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside'
    if (!position || position !== next) onDragOverRow({ uid: node.uid, position: next })
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // dragleave also fires when the pointer crosses onto one of the row's own
    // controls; ignore those so the indicator does not flicker.
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    onDragLeaveRow(node.uid)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const uid = e.dataTransfer.getData('text/plain') || dragUid
    if (uid && position && confirmMove(uid, node.uid, position)) {
      moveNode(uid, node.uid, position)
    }
    onDragEnd()
  }

  /**
   * Dragging a field into or out of a group changes the path its answers are
   * stored under, orphaning every one of them — the same loss `confirmDestructive`
   * guards for a rename or a remove, reached by a different gesture and, until
   * now, with nothing asked.
   *
   * Only a change of *parent* counts. Reordering among siblings leaves the path
   * alone, because answers are keyed by name at each level and never by
   * position, so warning there would be the crying-wolf failure again.
   */
  const confirmMove = (dragUid_: string, targetUid: string, pos: DropPosition): boolean => {
    const nodes = useEditorStore.getState().nodes
    const oldParent = parentUidOf(nodes, dragUid_)
    const newParent = pos === 'inside' ? targetUid : parentUidOf(nodes, targetUid)
    if (oldParent === undefined || newParent === undefined) return true
    if (oldParent === newParent) return true // a reorder: nothing moves

    const path = nodePathNames(nodes, dragUid_)
    if (!path) return true
    const count = countPapersUsingField(papers, path)
    const links = countLinksUsingField(papers, path)
    if (count === 0 && links === 0) return true
    const parts: string[] = []
    if (count > 0) parts.push(`${count === 1 ? '1 paper records an answer' : `${count} papers record answers`}`)
    if (links > 0) {
      parts.push(
        `${links === 1 ? '1 paper has a PDF highlight/note linked' : `${links} papers have PDF highlights/notes linked`}`,
      )
    }
    return window.confirm(
      `${parts.join(', and ')} under "${path.join(' / ')}". Moving it changes where that belongs, so ` +
        `it will be discarded — including every reviewer's own — the next time the project is saved, ` +
        `and it cannot be undone afterwards.\n\nContinue?`,
    )
  }

  const setOption = (index: number, value: string) =>
    updateNode(node.uid, { options: node.options.map((o, i) => (i === index ? value : o)) })

  // Siblings this node can be gated on: same parent's children (or the root
  // list, if this node has no parent), excluding groups and this node itself.
  // Recomputed on every render (not memoized) — it depends on the whole tree
  // (any sibling's name/kind), not just this node's own props.
  const allNodes = useEditorStore((s) => s.nodes)
  const parentUid = parentUidOf(allNodes, node.uid)
  const siblings = parentUid ? (findNode(allNodes, parentUid)?.children ?? []) : allNodes
  const siblingFieldOptions = siblings.filter((s) => s.uid !== node.uid && s.kind !== 'group')

  const rowClass = [
    'schema-row',
    dragging ? 'dragging' : '',
    position ? `drag-over-${position}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="schema-node">
      <div
        className={rowClass}
        draggable={armed}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span
          className="schema-handle"
          title="Drag to reorder or nest"
          aria-hidden="true"
          onPointerDown={() => setArmed(true)}
          onPointerUp={() => setArmed(false)}
        >
          ⠿
        </span>

        {hasChildren ? (
          <button
            type="button"
            className="icon-btn schema-caret"
            title={node.collapsed ? 'Expand children' : 'Collapse children'}
            aria-expanded={!node.collapsed}
            onClick={() => toggleCollapsed(node.uid)}
          >
            {node.collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="schema-caret-spacer" />
        )}

        <input
          className="schema-input schema-name"
          placeholder="Field name"
          value={node.name}
          onFocus={() => {
            nameOnFocus.current = node.name
          }}
          onChange={(e) => updateNode(node.uid, { name: e.target.value })}
          onBlur={commitRename}
        />

        <select
          className="schema-input schema-kind"
          value={node.kind}
          title="What kind of value this field holds"
          onChange={(e) => updateNode(node.uid, { kind: e.target.value as EditorNodeKind })}
        >
          {KIND_LABELS.map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>

        <label className="schema-bound" title="Minimum number of entries (0 = optional)">
          <span className="schema-bound-label">min</span>
          <input
            type="number"
            min={0}
            step={1}
            className="schema-input schema-num"
            value={node.min}
            onChange={(e) => updateNode(node.uid, { min: toInt(e.target.value, 0) })}
          />
        </label>

        <label className="schema-bound" title="Maximum number of entries">
          <span className="schema-bound-label">max</span>
          <input
            type="number"
            min={1}
            step={1}
            className="schema-input schema-num"
            disabled={unbounded}
            value={unbounded ? '' : node.max ?? 1}
            onChange={(e) => updateNode(node.uid, { max: Math.max(1, toInt(e.target.value, 1)) })}
          />
        </label>

        <label className="schema-unbounded" title="Allow any number of entries">
          <input
            type="checkbox"
            checked={unbounded}
            onChange={(e) =>
              // Leaving "unbounded" restores a max that cannot sit below min.
              updateNode(node.uid, { max: e.target.checked ? null : Math.max(1, node.min) })
            }
          />
          <span>∞</span>
        </label>

        {/* Not offered for a boolean: an unticked box is already a real answer
            (`false`), so a boolean is never "empty" and "required" on one can
            never fire — see `resolveSchema`, which drops the flag on load too. */}
        {node.kind !== 'group' && node.kind !== 'boolean' && (
          <label className="schema-required" title="The reviewer must fill this field in">
            <input
              type="checkbox"
              checked={node.required}
              onChange={(e) => updateNode(node.uid, { required: e.target.checked })}
            />
            <span>Required</span>
          </label>
        )}

        <input
          className="schema-input schema-desc"
          placeholder="Description (shown on hover)"
          value={node.description}
          onChange={(e) => updateNode(node.uid, { description: e.target.value })}
        />

        {node.kind !== 'group' && (
          <select
            className="schema-input schema-visible-if"
            title="Only show this field once the chosen sibling field has an answer"
            value={node.visibleIf}
            onChange={(e) => updateNode(node.uid, { visibleIf: e.target.value })}
          >
            <option value="">Always visible</option>
            {siblingFieldOptions.map((s) => (
              <option key={s.uid} value={s.name}>
                Show only if "{s.name}" answered
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          className="add-btn schema-add-child"
          title="Add a nested field under this one"
          onClick={() => addNode(node.uid)}
        >
          + Child
        </button>
        <button
          type="button"
          className="remove-btn"
          title="Remove this field and its children"
          onClick={() => {
            if (confirmDestructive('remove', node.name, nameOnFocus.current)) removeNode(node.uid)
          }}
        >
          ×
        </button>
      </div>

      {node.kind === 'string' && (
        <div className="schema-options">
          {node.options.map((option, i) => (
            <div className="schema-option" key={i}>
              <input
                className="schema-input"
                placeholder={`Option ${i + 1}`}
                value={option}
                onChange={(e) => setOption(i, e.target.value)}
              />
              <button
                type="button"
                className="remove-btn"
                title="Remove this option"
                onClick={() =>
                  updateNode(node.uid, { options: node.options.filter((_, j) => j !== i) })
                }
              >
                ×
              </button>
            </div>
          ))}
          <div className="schema-options-foot">
            <button
              type="button"
              className="add-btn"
              onClick={() => updateNode(node.uid, { options: [...node.options, ''] })}
            >
              + Add option
            </button>
            <span className="schema-hint">
              {node.options.length === 0
                ? 'No options: free text.'
                : 'With options: a dropdown of these values.'}
            </span>
          </div>
        </div>
      )}

      {hasChildren && !node.collapsed && (
        <div className="schema-children">
          {node.children.map((child) => (
            <SchemaNodeRow
              key={child.uid}
              node={child}
              ancestors={childAncestors}
              inDragged={isSubtree}
              dragUid={dragUid}
              dropTarget={dropTarget}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOverRow={onDragOverRow}
              onDragLeaveRow={onDragLeaveRow}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Parse an integer field, falling back while the input is empty or mid-edit. */
function toInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

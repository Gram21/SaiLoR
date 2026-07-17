import { useState, type DragEvent } from 'react'
import {
  useEditorStore,
  type DropPosition,
  type EditorNode,
  type EditorNodeKind,
} from '../state/editorStore'
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

interface SchemaNodeRowProps {
  node: EditorNode
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

  // The row itself carries the drag, but only once the handle is pressed:
  // a permanently draggable row would break text selection inside its inputs.
  const [armed, setArmed] = useState(false)

  const dragging = dragUid === node.uid
  const isSubtree = dragging || inDragged
  const position = dropTarget && dropTarget.uid === node.uid ? dropTarget.position : null

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
    if (uid && position) moveNode(uid, node.uid, position)
    onDragEnd()
  }

  const setOption = (index: number, value: string) =>
    updateNode(node.uid, { options: node.options.map((o, i) => (i === index ? value : o)) })

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
          onChange={(e) => updateNode(node.uid, { name: e.target.value })}
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

        {node.kind !== 'group' && (
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
          onClick={() => removeNode(node.uid)}
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

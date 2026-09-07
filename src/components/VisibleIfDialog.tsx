import { useEffect, useState, type DragEvent } from 'react'
import { useEditorStore, type DropPosition, type EditorNode } from '../state/editorStore'
import {
  isConditionGroup,
  type VisibleCondition,
  type VisibleIfEntry,
  type VisibleIfSpec,
} from '../model/schema'

/**
 * One condition's gate text, e.g. `"Relevant" = Yes` or
 * `"Study type" has any answer`.
 * Values need no schema lookup to render: a boolean condition carries real
 * booleans in `equals`, a string one carries the option strings themselves.
 */
function describeCondition(cond: VisibleCondition): string {
  const values = cond.equals ?? []
  if (values.length === 0) return `"${cond.field}" has any answer`
  const shown = values.map((v) => (v === true ? 'Yes' : v === false ? 'No' : v))
  return `"${cond.field}" = ${shown.join(' or ')}`
}

/** One entry spelled out; a nested group is parenthesised so the nesting —
 *  and with it the precedence of its own AND/OR — is unambiguous. The root
 *  group needs no brackets of its own, hence `top`. */
function describeEntry(entry: VisibleIfEntry, top = false): string {
  if (!isConditionGroup(entry)) return describeCondition(entry)
  if (entry.conditions.length === 0) return '(no conditions yet)'
  const inner = entry.conditions
    .map((e) => describeEntry(e))
    .join(entry.mode === 'all' ? ' and ' : ' or ')
  return top ? inner : `(${inner})`
}

/**
 * The one-line label for a node's gate — used both for the schema row's link
 * button and (via {@link describeVisibleIfFull}) its tooltip, so the two can
 * never drift apart. Deliberately short: anything with more than one entry is
 * only counted, and the full text lives in the tooltip.
 */
export function describeVisibleIf(spec: VisibleIfSpec | null): string {
  if (!spec || spec.conditions.length === 0) return 'Always visible'
  if (spec.conditions.length === 1) {
    const only = spec.conditions[0]
    // A lone group adds no meaning of its own — describe what is inside it.
    return isConditionGroup(only) ? describeVisibleIf(only) : `If ${describeCondition(only)}`
  }
  return `If ${spec.mode === 'all' ? 'all' : 'any'} of ${spec.conditions.length} conditions`
}

/** The same gate spelled out in full, for the button's `title`. */
export function describeVisibleIfFull(spec: VisibleIfSpec | null): string {
  if (!spec || spec.conditions.length === 0) {
    return 'Always visible — this field/group is never hidden.'
  }
  return `Only shown if ${describeEntry(spec, true)}.`
}

/** The values a condition on this field may match, if any: a boolean's
 *  true/false, or a string field's own options. Anything else (free text,
 *  number, year) has no closed set, so only "has any answer" is offered — see
 *  `resolveEquals` in schema.ts, which drops an `equals` on those anyway. */
function optionsOf(field: EditorNode | undefined): string[] {
  if (!field || field.kind !== 'string') return []
  return field.options.filter((o) => o.trim() !== '')
}

/** What kind of answer a watchable field holds, in the reviewer's words. */
export function kindLabel(field: EditorNode | undefined): string {
  if (!field) return 'unknown field'
  switch (field.kind) {
    case 'boolean':
      return 'Yes/No'
    case 'number':
      return 'Number'
    case 'year':
      return 'Year'
    case 'group':
      return 'Group'
    default: {
      const count = optionsOf(field).length
      return count > 0 ? `Text, ${count} fixed choice${count === 1 ? '' : 's'}` : 'Free text'
    }
  }
}

/** Where a watchable field lives, relative to the node being gated. */
export function whereLabel(levelsUp: number, container: string | null): string {
  if (levelsUp === 0) return 'Same level'
  const base = levelsUp === 1 ? '1 level up (parent)' : `${levelsUp} levels up`
  return container ? `${base}, in "${container}"` : base
}

/**
 * Which of the three ranks a target belongs to — the order the picker lists
 * them in, and what decides whether `value` is a bare name or a path.
 */
export type GateTargetGroup = 'same' | 'ancestor' | 'elsewhere'

/** A legal gate target plus the level information shown next to it. */
export interface GateTarget {
  node: EditorNode
  /**
   * What goes into `cond.field`. A same-level or ancestor field keeps storing
   * its bare name — that is the per-instance-correct reference inside a
   * repeatable group — while anything else is stored as its slash-joined
   * absolute path from the schema root, the same shape as `ResolvedDef.id`.
   */
  value: string
  group: GateTargetGroup
  levelsUp: number
  /** The group the target itself sits in, if any — for "…, in "Findings"". */
  container: string | null
  /** The target's absolute path from the schema root, root name first. */
  path: string[]
}

/** Every typed field in the tree, in document order, with its absolute path.
 *  `selfUid` is skipped along with everything under it: a node can never be
 *  gated on itself, and a gate on its own subtree could never be evaluated. */
function walkFields(
  nodes: EditorNode[],
  prefix: string[],
  selfUid: string,
  out: GateTarget[],
): void {
  for (const node of nodes) {
    if (node.uid === selfUid) continue
    const path = [...prefix, node.name]
    // A group holds no answer of its own, so it is never a target — but its
    // children still are.
    if (node.kind !== 'group') {
      out.push({ node, value: path.join('/'), group: 'elsewhere', levelsUp: 0, container: null, path })
    }
    walkFields(node.children, path, selfUid, out)
  }
}

/**
 * The pickable fields, in the order the reviewer wants to read them: the same
 * level first, then the ancestor chain nearest-first, then everything else in
 * schema document order.
 *
 * `nodePath` is the gated node's own answer-tree path (root first, its own name
 * last), which is what turns an ancestor into a distance: the deeper its name
 * sits in that path, the fewer levels up it is. `nodes` is the whole editor
 * tree, needed for the third rank, and `selfUid` excludes the gated node and
 * its own subtree from it.
 */
export function buildTargets(
  siblings: EditorNode[],
  ancestors: EditorNode[],
  nodePath: string[],
  nodes: EditorNode[],
  selfUid: string,
): GateTarget[] {
  const chain = nodePath.slice(0, -1)
  const local: GateTarget[] = [
    ...siblings.map((node) => ({
      node,
      value: node.name,
      group: 'same' as const,
      levelsUp: 0,
      container: null,
      path: [...chain, node.name],
    })),
    ...ancestors.map((node, i) => {
      const idx = chain.lastIndexOf(node.name)
      const common = { node, value: node.name, group: 'ancestor' as const }
      if (idx < 0) return { ...common, levelsUp: i + 1, container: null, path: [node.name] }
      return {
        ...common,
        levelsUp: chain.length - idx,
        container: idx > 0 ? chain[idx - 1] : null,
        path: chain.slice(0, idx + 1),
      }
    }),
  ]

  // The two local ranks win: they keep the bare-name reference, so the same
  // field must not also appear as a path further down the list.
  const seen = new Set(local.map((t) => t.node.uid))
  const rest: GateTarget[] = []
  walkFields(nodes, [], selfUid, rest)
  return [...local, ...rest.filter((t) => !seen.has(t.node.uid))]
}

/** One option's text: where the field lives, and what kind of answer it holds.
 *  A cross-branch target shows its whole path — that is the only thing telling
 *  two same-named fields in different branches apart. */
export function targetLabel(t: GateTarget): string {
  if (t.group === 'elsewhere') {
    return `${t.path.join(' / ')} — elsewhere in the schema · ${kindLabel(t.node)}`
  }
  return `${t.node.name} — ${whereLabel(t.levelsUp, t.container)} · ${kindLabel(t.node)}`
}

/**
 * Rewrite the group at `path` (empty = the root group) through `fn`, leaving
 * every other object untouched. One recursion serves all four edits below, so
 * the dialog needs no tree-walking of its own.
 */
export function mapGroupAt(
  spec: VisibleIfSpec,
  path: number[],
  fn: (group: VisibleIfSpec) => VisibleIfSpec,
): VisibleIfSpec {
  if (path.length === 0) return fn(spec)
  const [i, ...rest] = path
  const child = spec.conditions[i]
  if (!child || !isConditionGroup(child)) return spec
  const conditions = spec.conditions.slice()
  conditions[i] = mapGroupAt(child, rest, fn)
  return { ...spec, conditions }
}

/** The entry at `path`, or undefined if the path leads nowhere. */
function entryAt(spec: VisibleIfSpec, path: number[]): VisibleIfEntry | undefined {
  let entry: VisibleIfEntry | undefined = spec
  for (const i of path) {
    if (!entry || !isConditionGroup(entry)) return undefined
    entry = entry.conditions[i]
  }
  return entry
}

/** Append an entry to the group at `path`. */
export function addEntryAt(
  spec: VisibleIfSpec,
  path: number[],
  entry: VisibleIfEntry,
): VisibleIfSpec {
  return mapGroupAt(spec, path, (g) => ({
    ...g,
    conditions: [...g.conditions, entry],
  }))
}

/** Replace the entry at `path` (its last index is the entry's own slot). */
export function replaceEntryAt(
  spec: VisibleIfSpec,
  path: number[],
  entry: VisibleIfEntry,
): VisibleIfSpec {
  const i = path[path.length - 1]
  return mapGroupAt(spec, path.slice(0, -1), (g) => ({
    ...g,
    conditions: g.conditions.map((e, j) => (j === i ? entry : e)),
  }))
}

/** Drop the entry at `path`. */
export function removeEntryAt(spec: VisibleIfSpec, path: number[]): VisibleIfSpec {
  const i = path[path.length - 1]
  return mapGroupAt(spec, path.slice(0, -1), (g) => ({
    ...g,
    conditions: g.conditions.filter((_, j) => j !== i),
  }))
}

/**
 * Swap the entry at `path` with its neighbour `delta` slots away inside the
 * same group — the reorder gesture, for a condition and a nested group alike.
 * Out-of-range targets are no-ops, so callers need no bounds check beyond
 * disabling the button.
 */
export function moveEntryAt(spec: VisibleIfSpec, path: number[], delta: number): VisibleIfSpec {
  const i = path[path.length - 1]
  return mapGroupAt(spec, path.slice(0, -1), (g) => {
    const j = i + delta
    if (j < 0 || j >= g.conditions.length) return g
    const conditions = g.conditions.slice()
    ;[conditions[i], conditions[j]] = [conditions[j], conditions[i]]
    return { ...g, conditions }
  })
}

const samePath = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Whether relocating the entry at `from` to `position` of the entry at `to` is
 * a legal move, judged from the two paths alone. Both the drag-over handler
 * (which refuses a drop by *not* preventing the default, so the cursor says so
 * on its own) and {@link moveEntryTo} ask this, so the gesture and the edit can
 * never disagree about what is allowed.
 */
export function canMoveEntry(from: number[], to: number[], position: DropPosition): boolean {
  // The root group is the gate itself: it cannot be moved, and nothing sits
  // beside it to be moved next to.
  if (from.length === 0) return false
  if (position !== 'inside' && to.length === 0) return false
  // Dropping a group into itself or into its own descendant would detach the
  // subtree from the tree entirely.
  const under = to.length >= from.length && from.every((i, k) => to[k] === i)
  if (under && (position === 'inside' || to.length > from.length)) return false
  // Landing beside itself is the identity move, not an edit.
  if (position !== 'inside' && samePath(to, from)) return false
  return true
}

/** Insert `entry` into the group at `path` at `index`; the index is clamped,
 *  so `Infinity` appends. */
function insertEntryAt(
  spec: VisibleIfSpec,
  path: number[],
  entry: VisibleIfEntry,
  index: number,
): VisibleIfSpec {
  return mapGroupAt(spec, path, (g) => {
    const conditions = g.conditions.slice()
    conditions.splice(index, 0, entry)
    return { ...g, conditions }
  })
}

/**
 * Relocate the entry at `from` — a condition or a whole group, carrying its
 * conditions and its own `mode` — to `position` of the entry at `to`:
 * `'before'`/`'after'` make it that entry's sibling, `'inside'` appends it to
 * that group (with `to` empty meaning the root group). This is the
 * drag-and-drop edit, and the reason moving an entry between groups no longer
 * means deleting and rebuilding it.
 *
 * Immutable, and a no-op — the very same spec back — for anything
 * {@link canMoveEntry} refuses, plus an `'inside'` aimed at a condition rather
 * than a group.
 */
export function moveEntryTo(
  spec: VisibleIfSpec,
  from: number[],
  to: number[],
  position: DropPosition,
): VisibleIfSpec {
  if (!canMoveEntry(from, to, position)) return spec
  const entry = entryAt(spec, from)
  if (!entry) return spec
  // "Inside" only means anything for a group; `to` empty is the root group.
  const into = entryAt(spec, to)
  if (position === 'inside' && !(into && isConditionGroup(into))) return spec

  const depth = from.length - 1
  const fromParent = from.slice(0, depth)
  const fromIndex = from[depth]

  // Taking the entry out shifts every later index in its own parent, so both
  // the destination group's path and the slot inside it are read in the tree
  // *after* the removal.
  const dest = position === 'inside' ? to : to.slice(0, -1)
  const shifted =
    dest.length > depth && samePath(dest.slice(0, depth), fromParent) && dest[depth] > fromIndex
      ? [...dest.slice(0, depth), dest[depth] - 1, ...dest.slice(depth + 1)]
      : dest
  let index =
    position === 'inside' ? Infinity : to[to.length - 1] + (position === 'after' ? 1 : 0)
  if (samePath(shifted, fromParent) && index > fromIndex) index -= 1

  return insertEntryAt(removeEntryAt(spec, from), shifted, entry, index)
}

/** Set the AND/OR mode of the group at `path`. */
export function setModeAt(spec: VisibleIfSpec, path: number[], mode: 'all' | 'any'): VisibleIfSpec {
  return mapGroupAt(spec, path, (g) => ({ ...g, mode }))
}

/**
 * Drop groups left with nothing in them, and the whole gate once nothing is
 * left at all. The store does this too (`cleanVisibleIf`, on save to file),
 * but doing it here keeps an abandoned "+ Add group" click out of the editor
 * state — and out of the row's condition count — from the start.
 */
export function pruneEmptyGroups(spec: VisibleIfSpec | null): VisibleIfSpec | null {
  if (!spec) return null
  const conditions: VisibleIfEntry[] = []
  for (const entry of spec.conditions) {
    if (!isConditionGroup(entry)) {
      conditions.push(entry)
      continue
    }
    const nested = pruneEmptyGroups(entry)
    if (nested) conditions.push(nested)
  }
  return conditions.length > 0 ? { ...spec, conditions } : null
}

interface VisibleIfDialogProps {
  node: EditorNode
  /** The gated node's own path through the schema tree, root first, its own
   *  name last — shown as the dialog's context and used to place ancestors. */
  nodePath: string[]
  /** Fields in the same children array — the legal same-level targets. */
  siblings: EditorNode[]
  /** Fields on the direct ancestor chain, nearest first, also legal targets. */
  ancestors: EditorNode[]
  /** The whole editor tree, for the cross-branch targets. */
  nodes: EditorNode[]
  onClose: () => void
}

/** The edits a nested group's UI needs, threaded down by path. */
interface GateActions {
  setMode: (path: number[], mode: 'all' | 'any') => void
  setEntry: (path: number[], entry: VisibleIfEntry) => void
  remove: (path: number[]) => void
  add: (path: number[], entry: VisibleIfEntry) => void
  move: (path: number[], delta: number) => void
  moveTo: (from: number[], to: number[], position: DropPosition) => void
}

/** Where the currently dragged entry would land. */
interface GateDropTarget {
  path: number[]
  position: DropPosition
}

/** The drag state the whole gate shares, so one entry's drag can be read by
 *  every possible drop target. */
interface GateDrag {
  path: number[] | null
  target: GateDropTarget | null
  setPath: (path: number[] | null) => void
  setTarget: (target: GateDropTarget | null) => void
}

/**
 * The drag/drop plumbing for one entry, as the props its handle and its own box
 * need. Modelled on the schema tree's rows, down to the details that matter
 * there: the box is only `draggable` once the handle is pressed (otherwise the
 * selects and checkboxes inside it stop working), and an illegal target is
 * refused by *not* preventing the dragover default, which makes the cursor say
 * so without a second visual language.
 *
 * `allowInside` is what separates the two kinds of entry: a group can also be
 * dropped into, a condition only beside.
 */
function useEntryDrag(
  path: number[],
  drag: GateDrag,
  actions: GateActions,
  allowInside: boolean,
) {
  const [armed, setArmed] = useState(false)
  const dragging = drag.path !== null && samePath(drag.path, path)
  const position =
    drag.target && samePath(drag.target.path, path) ? drag.target.position : null

  /** Which third of the box the cursor sits in. The root group is one big
   *  "inside": it has no siblings to land between. */
  const positionFor = (e: DragEvent<HTMLDivElement>): DropPosition => {
    if (!allowInside) {
      const rect = e.currentTarget.getBoundingClientRect()
      return (e.clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after'
    }
    if (path.length === 0) return 'inside'
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside'
  }

  return {
    /** On the `⠿` span: arms the drag, and nothing else. */
    handle: {
      className: 'schema-handle',
      title: 'Drag to move into another group, or to reorder',
      'aria-hidden': true as const,
      onPointerDown: () => setArmed(true),
      onPointerUp: () => setArmed(false),
    },
    /** On the entry's own box. */
    box: {
      draggable: armed,
      onDragStart: (e: DragEvent<HTMLDivElement>) => {
        // Firefox refuses to start a drag without any payload; the path itself
        // travels in React state, which every drop target already reads.
        e.dataTransfer.setData('text/plain', path.join('.'))
        e.dataTransfer.effectAllowed = 'move'
        e.stopPropagation()
        drag.setPath(path)
      },
      onDragEnd: () => {
        setArmed(false)
        drag.setPath(null)
        drag.setTarget(null)
      },
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        if (!drag.path) return
        const next = positionFor(e)
        // Not preventing the default marks this box as an invalid drop target.
        if (!canMoveEntry(drag.path, path, next)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (position !== next) drag.setTarget({ path, position: next })
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        // dragleave also fires when the pointer crosses onto one of the box's
        // own controls; ignore those so the indicator does not flicker. Only
        // clear the indicator if it still points here: the new box's dragover
        // already fired before this.
        const next = e.relatedTarget as Node | null
        if (next && e.currentTarget.contains(next)) return
        if (position) drag.setTarget(null)
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        e.stopPropagation()
        if (drag.path && position) actions.moveTo(drag.path, path, position)
        drag.setPath(null)
        drag.setTarget(null)
      },
    },
    /** The two state classes, sharing the schema tree's names and CSS idioms. */
    dragClass: [dragging ? 'dragging' : '', position ? `drag-over-${position}` : '']
      .filter(Boolean)
      .join(' '),
  }
}

/**
 * The per-entry controls: reorder within the group it sits in, or remove it.
 * Shared by a condition and a nested group, so both are moved the same way —
 * reordering only ever swaps siblings, which is why AND/OR needs no re-reading
 * afterwards (a group's own mode travels with it). These stay the keyboard
 * path: drag-and-drop is the addition, not the replacement.
 */
function EntryTools({
  path,
  count,
  what,
  actions,
}: {
  path: number[]
  /** How many entries the containing group holds, for the end stops. */
  count: number
  what: 'condition' | 'group'
  actions: GateActions
}) {
  const i = path[path.length - 1]
  return (
    <div className="visible-if-tools">
      <button
        type="button"
        className="icon-btn"
        title={`Move this ${what} up`}
        aria-label={`Move this ${what} up`}
        disabled={i === 0}
        onClick={() => actions.move(path, -1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-btn"
        title={`Move this ${what} down`}
        aria-label={`Move this ${what} down`}
        disabled={i >= count - 1}
        onClick={() => actions.move(path, 1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="remove-btn"
        title={`Remove this ${what}`}
        aria-label={`Remove this ${what}`}
        onClick={() => actions.remove(path)}
      >
        ×
      </button>
    </div>
  )
}

/** The field picker's three ranks, in the order the reviewer reads them. */
const TARGET_GROUPS: Array<[GateTargetGroup, string]> = [
  ['same', 'Same level'],
  ['ancestor', 'Ancestors'],
  ['elsewhere', 'Elsewhere in the schema'],
]

/** One leaf condition: which field, then how its answer must match. */
function ConditionRow({
  cond,
  path,
  count,
  targets,
  actions,
  drag,
}: {
  cond: VisibleCondition
  path: number[]
  count: number
  targets: GateTarget[]
  actions: GateActions
  drag: GateDrag
}) {
  const target = targets.find((t) => t.value === cond.field)
  const values = optionsOf(target?.node)
  const isBoolean = target?.node.kind === 'boolean'
  // Only a boolean or an option list has a closed set of values to match; on
  // anything else `resolveEquals` would drop an `equals` anyway.
  const canMatchValues = isBoolean || values.length > 0
  const valueMode = (cond.equals?.length ?? 0) > 0
  const name = `visible-if-match-${path.join('-')}`
  // A condition holds nothing, so it is only ever a before/after target.
  const { handle, box, dragClass } = useEntryDrag(path, drag, actions, false)

  return (
    <div className={`visible-if-row ${dragClass}`.trimEnd()} {...box}>
      <span {...handle}>⠿</span>

      <div className="visible-if-target">
        <select
          className="schema-input"
          value={cond.field}
          // Switching the field drops the old `equals`: its values belong to
          // the field that is no longer watched.
          onChange={(e) => actions.setEntry(path, { field: e.target.value })}
        >
          {TARGET_GROUPS.map(([group, label]) => {
            const inGroup = targets.filter((t) => t.group === group)
            if (inGroup.length === 0) return null
            return (
              <optgroup key={group} label={label}>
                {inGroup.map((t) => (
                  <option key={t.node.uid} value={t.value}>
                    {targetLabel(t)}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
        {/* The level and kind are already spelled out in every option of the
            select above, so they are not repeated here — only the case where
            the watched field is no longer a legal target needs saying. */}
        {!target && (
          <span className="schema-hint">
            This field is no longer at a level that can be watched.
          </span>
        )}
      </div>

      <div className="visible-if-match">
        <label>
          <input
            type="radio"
            name={name}
            checked={!valueMode}
            onChange={() => actions.setEntry(path, { field: cond.field })}
          />
          <span>has any answer</span>
        </label>
        <label
          title={
            canMatchValues ? undefined : 'Only yes/no fields and option lists have values to match'
          }
        >
          <input
            type="radio"
            name={name}
            checked={valueMode}
            disabled={!canMatchValues}
            onChange={() =>
              actions.setEntry(path, {
                field: cond.field,
                equals: isBoolean ? [true] : [values[0]],
              })
            }
          />
          <span>has a specific value</span>
        </label>

        {valueMode && isBoolean && (
          <select
            className="schema-input"
            value={cond.equals?.[0] === false ? 'no' : 'yes'}
            onChange={(e) =>
              actions.setEntry(path, {
                field: cond.field,
                equals: [e.target.value === 'yes'],
              })
            }
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        )}

        {valueMode && !isBoolean && (
          <div className="visible-if-values">
            {values.map((value) => {
              const checked = cond.equals?.includes(value) ?? false
              return (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? (cond.equals ?? []).filter((v) => v !== value)
                        : [...(cond.equals ?? []), value]
                      // Unticking the last value is the same statement as
                      // "has any answer", so it falls back to that mode.
                      actions.setEntry(path, {
                        field: cond.field,
                        ...(next.length > 0 ? { equals: next } : {}),
                      })
                    }}
                  />
                  <span>{value}</span>
                </label>
              )
            })}
            <span className="schema-hint">Any one of the ticked values counts.</span>
          </div>
        )}

        {!valueMode && (
          <span className="schema-hint">
            {isBoolean
              ? '"Has any answer" on a Yes/No field means the box is ticked — pick a specific value to match No.'
              : '"Has any answer" means any non-empty value.'}
            {!canMatchValues &&
              ` A ${kindLabel(target?.node).toLowerCase()} field has no fixed set of values, so this is the only test available.`}
          </span>
        )}
      </div>

      <EntryTools path={path} count={count} what="condition" actions={actions} />
    </div>
  )
}

/**
 * One group of the gate, rendering its own AND/OR control, its entries
 * indented beneath it, and its own add buttons — so a nested group is edited
 * exactly like the root one, at any depth.
 */
function ConditionGroup({
  group,
  siblingCount,
  path,
  targets,
  actions,
  drag,
}: {
  group: VisibleIfSpec
  path: number[]
  /** Entries in the group this one sits in — for its own reorder stops. */
  siblingCount: number
  targets: GateTarget[]
  actions: GateActions
  drag: GateDrag
}) {
  const isRoot = path.length === 0
  // A group holds entries, so it is a drop target in its own right — that is
  // the whole point of the gesture: moving a condition *into* another group.
  const { handle, box, dragClass } = useEntryDrag(path, drag, actions, true)

  return (
    <div
      className={[
        'visible-if-group',
        isRoot ? 'visible-if-group-root' : '',
        dragClass,
      ]
        .filter(Boolean)
        .join(' ')}
      {...box}
      // The root group is a destination — dropping into it moves an entry back
      // out to the top level — but it is not itself movable.
      draggable={isRoot ? false : box.draggable}
    >
      {/* A nested group always shows its header, even with one entry: without
          it the indent alone does not read as "this is a group". At the root,
          where the box and the word "group" would say nothing, the mode is
          offered only once AND and OR mean different things. */}
      {(!isRoot || group.conditions.length > 1) && (
        <div className="visible-if-mode">
          {!isRoot && <span {...handle}>⠿</span>}
          <span className="visible-if-mode-label">{isRoot ? 'Show when' : 'Group —'}</span>
          <select
            className="schema-input"
            value={group.mode}
            onChange={(e) => actions.setMode(path, e.target.value === 'any' ? 'any' : 'all')}
          >
            <option value="all">all of these must hold (AND)</option>
            <option value="any">any of these may hold (OR)</option>
          </select>
          {!isRoot && (
            <EntryTools path={path} count={siblingCount} what="group" actions={actions} />
          )}
        </div>
      )}

      {group.conditions.map((entry, i) => (
        <div className="visible-if-entry" key={i}>
          {i > 0 && (
            <span className="visible-if-joiner">{group.mode === 'all' ? 'and' : 'or'}</span>
          )}
          {isConditionGroup(entry) ? (
            <ConditionGroup
              group={entry}
              path={[...path, i]}
              siblingCount={group.conditions.length}
              targets={targets}
              actions={actions}
              drag={drag}
            />
          ) : (
            <ConditionRow
              cond={entry}
              path={[...path, i]}
              count={group.conditions.length}
              targets={targets}
              actions={actions}
              drag={drag}
            />
          )}
        </div>
      ))}

      {group.conditions.length === 0 && (
        <span className="schema-hint">
          Empty group — add a condition to it below, drag one into it, or it is dropped.
        </span>
      )}

      <div className="visible-if-group-foot">
        {/* Spelled out inside a nested group: its own add buttons sit only a
            few pixels above the parent's, and nothing else says which of the
            two a click lands in. */}
        {!isRoot && <span className="visible-if-mode-label">Add to this group:</span>}
        <button
          type="button"
          className="add-btn"
          title={isRoot ? 'Add a condition' : 'Add a condition to this group'}
          onClick={() => actions.add(path, { field: targets[0].value })}
        >
          + Add condition
        </button>
        <button
          type="button"
          className="add-btn"
          title={
            isRoot
              ? 'A group with its own AND/OR, nested inside this rule'
              : 'A group with its own AND/OR, nested inside this group'
          }
          onClick={() =>
            actions.add(path, {
              mode: group.mode === 'all' ? 'any' : 'all',
              conditions: [],
            })
          }
        >
          + Add group
        </button>
      </div>
    </div>
  )
}

/** True if any condition in the gate watches a field outside this node's own
 *  level and ancestor chain — the case whose repeatable-group rule needs
 *  saying, and only then. */
function usesElsewhere(entry: VisibleIfEntry, targets: GateTarget[]): boolean {
  if (isConditionGroup(entry)) return entry.conditions.some((e) => usesElsewhere(e, targets))
  return targets.find((t) => t.value === entry.field)?.group === 'elsewhere'
}

/**
 * Editor for one node's `visibleIf` gate. Modeled on `SchemaInfoDialog` (the
 * shared `.modal*` classes, closable by ×, Escape or an outside click) but
 * with Cancel/Save actions, because it edits rather than informs: the draft
 * lives here and is written to the store in a single `updateNode` on Save, so
 * neither the tree nor the undo stack sees every intermediate click.
 */
export function VisibleIfDialog({
  node,
  nodePath,
  siblings,
  ancestors,
  nodes,
  onClose,
}: VisibleIfDialogProps) {
  const updateNode = useEditorStore((s) => s.updateNode)
  const [draft, setDraft] = useState<VisibleIfSpec | null>(node.visibleIf)

  // Drag state is local and transient: it is a gesture in progress, not part
  // of the draft, so it never reaches the store even on Save.
  const [dragPath, setDragPath] = useState<number[] | null>(null)
  const [dropTarget, setDropTarget] = useState<GateDropTarget | null>(null)
  const drag: GateDrag = {
    path: dragPath,
    target: dropTarget,
    setPath: setDragPath,
    setTarget: setDropTarget,
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const targets = buildTargets(siblings, ancestors, nodePath, nodes, node.uid)
  const root = draft ?? { mode: 'all' as const, conditions: [] }

  // Every edit goes through the path helpers above, so the draft is replaced
  // wholesale rather than mutated — the store's own copy stays untouched
  // until Save.
  const actions: GateActions = {
    setMode: (path, mode) => setDraft(setModeAt(root, path, mode)),
    setEntry: (path, entry) => setDraft(replaceEntryAt(root, path, entry)),
    remove: (path) => setDraft(pruneEmptyGroups(removeEntryAt(root, path))),
    add: (path, entry) => setDraft(addEntryAt(root, path, entry)),
    move: (path, delta) => setDraft(moveEntryAt(root, path, delta)),
    // Deliberately not pruned: emptying a group by dragging its last condition
    // out should not also delete the group the reviewer is still filling in.
    // Save prunes what is genuinely abandoned.
    moveTo: (from, to, position) => setDraft(moveEntryTo(root, from, to, position)),
  }

  const save = () => {
    updateNode(node.uid, { visibleIf: pruneEmptyGroups(draft) })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal visible-if-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="When to show this field"
      >
        <div className="modal-head">
          <strong>When to show "{node.name || 'this field'}"</strong>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="visible-if-context">
            {nodePath.join(' / ') || node.name}
            <span className="visible-if-kind">{kindLabel(node)}</span>
          </p>

          {targets.length === 0 ? (
            <p className="schema-hint">
              Nothing to gate on: the schema holds no other field that records an answer.
            </p>
          ) : (
            <>
              <ConditionGroup
                group={root}
                path={[]}
                siblingCount={0}
                targets={targets}
                actions={actions}
                drag={drag}
              />

              {usesElsewhere(root, targets) && (
                <p className="schema-hint visible-if-elsewhere-note">
                  A field from elsewhere in the schema is read from the first entry of any
                  repeatable group on its way there.
                </p>
              )}

              <p className="visible-if-summary">{describeVisibleIfFull(pruneEmptyGroups(draft))}</p>
            </>
          )}
        </div>
        <div className="visible-if-actions">
          {/* Left of Cancel/Save, because it is the other outcome the dialog
              can produce, not a step towards one — and it throws work away, so
              it says what it removes rather than only what it turns on. */}
          <div className="visible-if-clear">
            <button type="button" onClick={() => setDraft(null)} disabled={draft === null}>
              Always visible
            </button>
            <span className="schema-hint">
              {draft === null
                ? 'No conditions: this field/group is always shown.'
                : 'Removes every condition above — the field/group is then always shown.'}
            </span>
          </div>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

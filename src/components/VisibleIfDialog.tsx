import { useEffect, useState, type DragEvent } from 'react'
import { useEditorStore, type DropPosition, type EditorNode } from '../state/editorStore'
import {
  isConditionGroup,
  type VisibleCondition,
  type VisibleIfEntry,
  type VisibleIfSpec,
} from '../model/schema'
import { t, tp, useT } from '../i18n'

/** One condition's gate text, e.g. `"Relevant" = Yes` or `"Study type" has
 *  any answer`. No schema lookup needed: `equals` already carries the real
 *  booleans or option strings. */
function describeCondition(cond: VisibleCondition): string {
  const values = cond.equals ?? []
  if (values.length === 0) return t('editor.visibleIf.hasAnyAnswerOf', { field: cond.field })
  const shown = values.map((v) => (v === true ? t('editor.visibleIf.yes') : v === false ? t('editor.visibleIf.no') : v))
  return t('editor.visibleIf.equals', { field: cond.field, values: shown.join(t('editor.visibleIf.orJoin')) })
}

/** One entry spelled out; a nested group is parenthesised so its AND/OR
 *  precedence is unambiguous. `top` skips the brackets for the root group. */
function describeEntry(entry: VisibleIfEntry, top = false): string {
  if (!isConditionGroup(entry)) return describeCondition(entry)
  if (entry.conditions.length === 0) return t('editor.visibleIf.noConditions')
  const inner = entry.conditions
    .map((e) => describeEntry(e))
    .join(entry.mode === 'all' ? t('editor.visibleIf.andJoin') : t('editor.visibleIf.orJoin'))
  return top ? inner : `(${inner})`
}

/** The one-line label for a node's gate, shown on the schema row's link
 *  button. Deliberately short — more than one entry is only counted, the
 *  full text lives in {@link describeVisibleIfFull}'s tooltip. */
export function describeVisibleIf(spec: VisibleIfSpec | null): string {
  if (!spec || spec.conditions.length === 0) return t('editor.visibleIf.always')
  if (spec.conditions.length === 1) {
    const only = spec.conditions[0]
    // A lone group adds no meaning of its own — describe what is inside it.
    return isConditionGroup(only)
      ? describeVisibleIf(only)
      : t('editor.visibleIf.ifCondition', { condition: describeCondition(only) })
  }
  return t('editor.visibleIf.ifMany', {
    mode: spec.mode === 'all' ? t('editor.visibleIf.modeAll') : t('editor.visibleIf.modeAny'),
    count: spec.conditions.length,
  })
}

/** The same gate spelled out in full, for the button's `title`. */
export function describeVisibleIfFull(spec: VisibleIfSpec | null): string {
  if (!spec || spec.conditions.length === 0) {
    return t('editor.visibleIf.alwaysFull')
  }
  return t('editor.visibleIf.onlyIf', { condition: describeEntry(spec, true) })
}

/** The values a condition on this field may match, if any. Free text/number/
 *  year have no closed set, so only "has any answer" is offered (see
 *  `resolveEquals` in schema.ts, which drops `equals` on those anyway). */
function optionsOf(field: EditorNode | undefined): string[] {
  if (!field || field.kind !== 'string') return []
  return field.options.filter((o) => o.trim() !== '')
}

/** What kind of answer a watchable field holds, in the reviewer's words. */
export function kindLabel(field: EditorNode | undefined): string {
  if (!field) return t('editor.visibleIf.kind.unknown')
  switch (field.kind) {
    case 'boolean':
      return t('editor.visibleIf.kind.yesNo')
    case 'number':
      return t('editor.visibleIf.kind.number')
    case 'year':
      return t('editor.visibleIf.kind.year')
    case 'group':
      return t('editor.visibleIf.kind.group')
    default: {
      const count = optionsOf(field).length
      return count > 0 ? tp('editor.visibleIf.textChoices', count) : t('editor.visibleIf.kind.freeText')
    }
  }
}

/** The kind of a field as a lowercase phrase inside a sentence. */
function kindPhrase(field: EditorNode | undefined): string {
  if (!field) return t('editor.visibleIf.phrase.unknown')
  switch (field.kind) {
    case 'boolean':
      return t('editor.visibleIf.phrase.yesNo')
    case 'number':
      return t('editor.visibleIf.phrase.number')
    case 'year':
      return t('editor.visibleIf.phrase.year')
    case 'group':
      return t('editor.visibleIf.phrase.group')
    default:
      return t('editor.visibleIf.phrase.freeText')
  }
}

/** Where a watchable field lives, relative to the node being gated. */
export function whereLabel(levelsUp: number, container: string | null): string {
  if (levelsUp === 0) return t('editor.visibleIf.sameLevel')
  const base = tp('editor.visibleIf.levelsUp', levelsUp)
  return container ? t('editor.visibleIf.inContainer', { base, container }) : base
}

/** Which of the three ranks a target belongs to — the picker's list order,
 *  and what decides whether `value` is a bare name or a path. */
export type GateTargetGroup = 'same' | 'ancestor' | 'elsewhere'

/** A legal gate target plus the level information shown next to it. */
export interface GateTarget {
  node: EditorNode
  /** What goes into `cond.field`. Same-level/ancestor fields keep their bare
   *  name (the per-instance-correct reference inside a repeatable group);
   *  anything else stores its slash-joined absolute path, like `ResolvedDef.id`. */
  value: string
  group: GateTargetGroup
  levelsUp: number
  /** The group the target itself sits in, if any — for "…, in "Findings"". */
  container: string | null
  /** The target's absolute path from the schema root, root name first. */
  path: string[]
}

/** Every typed field in the tree, in document order, with its absolute path.
 *  `selfUid` and its subtree are skipped: a node can't be gated on itself. */
function walkFields(
  nodes: EditorNode[],
  prefix: string[],
  selfUid: string,
  out: GateTarget[],
): void {
  for (const node of nodes) {
    if (node.uid === selfUid) continue
    const path = [...prefix, node.name]
    // A group holds no answer of its own, so it is never a target.
    if (node.kind !== 'group') {
      out.push({ node, value: path.join('/'), group: 'elsewhere', levelsUp: 0, container: null, path })
    }
    walkFields(node.children, path, selfUid, out)
  }
}

/** The pickable fields: same level first, then ancestors nearest-first, then
 *  everything else in document order. `nodePath` (root first, own name last)
 *  turns an ancestor's position into a levels-up distance. `nodes` is the
 *  whole tree for the third rank; `selfUid` excludes the gated node's subtree. */
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

  // Local ranks win and keep the bare-name reference; dedupe so the same
  // field doesn't also appear as a path further down.
  const seen = new Set(local.map((t) => t.node.uid))
  const rest: GateTarget[] = []
  walkFields(nodes, [], selfUid, rest)
  return [...local, ...rest.filter((t) => !seen.has(t.node.uid))]
}

/** One option's text: where the field lives, and what kind of answer it holds.
 *  A cross-branch target shows its whole path to disambiguate same-named fields. */
export function targetLabel(target: GateTarget): string {
  if (target.group === 'elsewhere') {
    return t('editor.visibleIf.elsewhereTarget', { path: target.path.join(' / '), kind: kindLabel(target.node) })
  }
  return t('editor.visibleIf.targetLabel', {
    name: target.node.name,
    where: whereLabel(target.levelsUp, target.container),
    kind: kindLabel(target.node),
  })
}

/** Rewrite the group at `path` (empty = root) through `fn`, leaving every
 *  other object untouched. Backs all four edits below. */
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

/** Swap the entry at `path` with its neighbour `delta` slots away. Out-of-range
 *  is a no-op, so callers need no bounds check beyond disabling the button. */
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

/** Whether relocating `from` to `position` of `to` is legal, judged from the
 *  two paths alone. Shared by the drag-over handler and {@link moveEntryTo}
 *  so the gesture and the edit never disagree. */
export function canMoveEntry(from: number[], to: number[], position: DropPosition): boolean {
  // The root group can't be moved, and nothing sits beside it.
  if (from.length === 0) return false
  if (position !== 'inside' && to.length === 0) return false
  // Dropping a group into itself/its own descendant would detach the subtree.
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

// [impl->req~edt-60~1]
/** Relocate the entry at `from` to `position` of the entry at `to`:
 *  `'before'`/`'after'` make it a sibling, `'inside'` appends it to that group
 *  (`to` empty = root group). No-op for anything {@link canMoveEntry} refuses,
 *  or `'inside'` aimed at a condition rather than a group. */
export function moveEntryTo(
  spec: VisibleIfSpec,
  from: number[],
  to: number[],
  position: DropPosition,
): VisibleIfSpec {
  if (!canMoveEntry(from, to, position)) return spec
  const entry = entryAt(spec, from)
  if (!entry) return spec
  // "Inside" only means anything for a group.
  const into = entryAt(spec, to)
  if (position === 'inside' && !(into && isConditionGroup(into))) return spec

  const depth = from.length - 1
  const fromParent = from.slice(0, depth)
  const fromIndex = from[depth]

  // Removing the entry shifts later indices in its own parent, so the
  // destination path/slot must be read as they'll be *after* removal.
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

/** Drop empty groups, and the whole gate once nothing is left. The store does
 *  this too (`cleanVisibleIf`, on save), but doing it here keeps an abandoned
 *  "+ Add group" click out of the editor state from the start. */
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

/** Drag/drop plumbing for one entry's handle and box, modelled on the schema
 *  tree's rows: the box is only `draggable` once the handle is pressed
 *  (otherwise selects/checkboxes inside it stop working), and an illegal
 *  target is refused by *not* preventing the dragover default, so the cursor
 *  says so on its own. `allowInside` separates a group (droppable into) from
 *  a condition (only besides). */
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
      title: t('editor.visibleIf.handleTitle'),
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
        // Not preventing default marks this as an invalid drop target.
        if (!canMoveEntry(drag.path, path, next)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (position !== next) drag.setTarget({ path, position: next })
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        // Also fires when crossing onto the box's own controls; ignore those
        // so the indicator doesn't flicker.
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

/** Per-entry controls: reorder within the group, or remove. Shared by a
 *  condition and a nested group (a group's own mode travels with it). The
 *  keyboard path — drag-and-drop is the addition, not the replacement. */
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
  const t = useT()
  const i = path[path.length - 1]
  const names =
    what === 'condition'
      ? {
          up: t('editor.visibleIf.moveUpCondition'),
          down: t('editor.visibleIf.moveDownCondition'),
          remove: t('editor.visibleIf.removeCondition'),
        }
      : {
          up: t('editor.visibleIf.moveUpGroup'),
          down: t('editor.visibleIf.moveDownGroup'),
          remove: t('editor.visibleIf.removeGroup'),
        }
  return (
    <div className="visible-if-tools">
      <button
        type="button"
        className="icon-btn"
        title={names.up}
        aria-label={names.up}
        disabled={i === 0}
        onClick={() => actions.move(path, -1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-btn"
        title={names.down}
        aria-label={names.down}
        disabled={i >= count - 1}
        onClick={() => actions.move(path, 1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="remove-btn"
        title={names.remove}
        aria-label={names.remove}
        onClick={() => actions.remove(path)}
      >
        ×
      </button>
    </div>
  )
}

/** The field picker's three ranks, in the order the reviewer reads them. */
function targetGroups(): Array<[GateTargetGroup, string]> {
  return [
    ['same', t('editor.visibleIf.sameLevel')],
    ['ancestor', t('editor.visibleIf.ancestors')],
    ['elsewhere', t('editor.visibleIf.elsewhereGroup')],
  ]
}

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
  const t = useT()
  const target = targets.find((x) => x.value === cond.field)
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
          {targetGroups().map(([group, label]) => {
            const inGroup = targets.filter((x) => x.group === group)
            if (inGroup.length === 0) return null
            return (
              <optgroup key={group} label={label}>
                {inGroup.map((x) => (
                  <option key={x.node.uid} value={x.value}>
                    {targetLabel(x)}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
        {/* Level/kind are already in the select's options; only the "no
            longer a legal target" case needs saying here. */}
        {!target && <span className="schema-hint">{t('editor.visibleIf.noLongerWatchable')}</span>}
      </div>

      <div className="visible-if-match">
        <label>
          <input
            type="radio"
            name={name}
            checked={!valueMode}
            onChange={() => actions.setEntry(path, { field: cond.field })}
          />
          <span>{t('editor.visibleIf.anyAnswer')}</span>
        </label>
        <label title={canMatchValues ? undefined : t('editor.visibleIf.onlyYesNoTitle')}>
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
          <span>{t('editor.visibleIf.specificValue')}</span>
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
            <option value="yes">{t('editor.visibleIf.yes')}</option>
            <option value="no">{t('editor.visibleIf.no')}</option>
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
            <span className="schema-hint">{t('editor.visibleIf.anyTicked')}</span>
          </div>
        )}

        {!valueMode && (
          <span className="schema-hint">
            {isBoolean ? t('editor.visibleIf.anyAnswerYesNoHint') : t('editor.visibleIf.anyAnswerTextHint')}
            {!canMatchValues &&
              ` ${t('editor.visibleIf.noFixedValues', { kind: kindPhrase(target?.node) })}`}
          </span>
        )}
      </div>

      <EntryTools path={path} count={count} what="condition" actions={actions} />
    </div>
  )
}

/** One group of the gate: AND/OR control, indented entries, and add buttons —
 *  so a nested group is edited exactly like the root one, at any depth. */
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
  const t = useT()
  const isRoot = path.length === 0
  // A group is a drop target in its own right: the point of the gesture is
  // moving a condition *into* another group.
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
      // The root group is a valid drop destination but not itself movable.
      draggable={isRoot ? false : box.draggable}
    >
      {/* Nested groups always show their header (indent alone doesn't read as
          "group"); root only shows it once it has >1 entry, where AND/OR
          starts to mean something. */}
      {(!isRoot || group.conditions.length > 1) && (
        <div className="visible-if-mode">
          {!isRoot && <span {...handle}>⠿</span>}
          <span className="visible-if-mode-label">
            {isRoot ? t('editor.visibleIf.showWhen') : t('editor.visibleIf.groupLabel')}
          </span>
          <select
            className="schema-input"
            value={group.mode}
            onChange={(e) => actions.setMode(path, e.target.value === 'any' ? 'any' : 'all')}
          >
            <option value="all">{t('editor.visibleIf.modeAllOption')}</option>
            <option value="any">{t('editor.visibleIf.modeAnyOption')}</option>
          </select>
          {!isRoot && (
            <EntryTools path={path} count={siblingCount} what="group" actions={actions} />
          )}
        </div>
      )}

      {group.conditions.map((entry, i) => (
        <div className="visible-if-entry" key={i}>
          {i > 0 && (
            <span className="visible-if-joiner">
              {group.mode === 'all' ? t('editor.visibleIf.joinerAnd') : t('editor.visibleIf.joinerOr')}
            </span>
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
        <span className="schema-hint">{t('editor.visibleIf.emptyGroup')}</span>
      )}

      <div className="visible-if-group-foot">
        {/* Nested group's add buttons sit close to the parent's; label
            clarifies which one a click lands in. */}
        {!isRoot && <span className="visible-if-mode-label">{t('editor.visibleIf.addToGroup')}</span>}
        <button
          type="button"
          className="add-btn"
          title={isRoot ? t('editor.visibleIf.addConditionTitle') : t('editor.visibleIf.addConditionGroupTitle')}
          onClick={() => actions.add(path, { field: targets[0].value })}
        >
          {t('editor.visibleIf.addCondition')}
        </button>
        <button
          type="button"
          className="add-btn"
          title={isRoot ? t('editor.visibleIf.addGroupRootTitle') : t('editor.visibleIf.addGroupNestedTitle')}
          onClick={() =>
            actions.add(path, {
              mode: group.mode === 'all' ? 'any' : 'all',
              conditions: [],
            })
          }
        >
          {t('editor.visibleIf.addGroup')}
        </button>
      </div>
    </div>
  )
}

/** True if any condition watches a field outside this node's own level and
 *  ancestor chain — the case where the repeatable-group rule needs saying. */
function usesElsewhere(entry: VisibleIfEntry, targets: GateTarget[]): boolean {
  if (isConditionGroup(entry)) return entry.conditions.some((e) => usesElsewhere(e, targets))
  return targets.find((t) => t.value === entry.field)?.group === 'elsewhere'
}

// [impl->req~edt-60~1]
/** Editor for one node's `visibleIf` gate. Modeled on `SchemaInfoDialog`
 *  (shared `.modal*` classes, closable by ×/Escape/outside-click) but with
 *  Cancel/Save: the draft lives here and hits the store in one `updateNode`
 *  on Save, so the undo stack doesn't see every intermediate click. */
export function VisibleIfDialog({
  node,
  nodePath,
  siblings,
  ancestors,
  nodes,
  onClose,
}: VisibleIfDialogProps) {
  const t = useT()
  const updateNode = useEditorStore((s) => s.updateNode)
  const [draft, setDraft] = useState<VisibleIfSpec | null>(node.visibleIf)

  // Drag state is a transient gesture, not part of the draft — never reaches
  // the store even on Save.
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

  // Every edit goes through the path helpers, replacing the draft wholesale —
  // the store's own copy stays untouched until Save.
  const actions: GateActions = {
    setMode: (path, mode) => setDraft(setModeAt(root, path, mode)),
    setEntry: (path, entry) => setDraft(replaceEntryAt(root, path, entry)),
    remove: (path) => setDraft(pruneEmptyGroups(removeEntryAt(root, path))),
    add: (path, entry) => setDraft(addEntryAt(root, path, entry)),
    move: (path, delta) => setDraft(moveEntryAt(root, path, delta)),
    // Deliberately not pruned: emptying a group by drag shouldn't delete it
    // while the reviewer is still filling it in. Save prunes what's abandoned.
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
        aria-label={t('editor.visibleIf.dialogLabel')}
      >
        <div className="modal-head">
          <strong>{t('editor.visibleIf.heading', { name: node.name || t('editor.visibleIf.thisField') })}</strong>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('editor.visibleIf.closeTitle')}
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="visible-if-context">
            {nodePath.join(' / ') || node.name}
            <span className="visible-if-kind">{kindLabel(node)}</span>
          </p>

          {targets.length === 0 ? (
            <p className="schema-hint">{t('editor.visibleIf.nothingToGate')}</p>
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
                <p className="schema-hint visible-if-elsewhere-note">{t('editor.visibleIf.elsewhereNote')}</p>
              )}

              <p className="visible-if-summary">{describeVisibleIfFull(pruneEmptyGroups(draft))}</p>
            </>
          )}
        </div>
        <div className="visible-if-actions">
          {/* Left of Cancel/Save: a separate outcome, not a step towards one —
              and it throws work away, so it states what it removes. */}
          <div className="visible-if-clear">
            <button
              type="button"
              onClick={() => setDraft(null)}
              disabled={draft === null}
              title={t('editor.visibleIf.clearTitle')}
            >
              {t('editor.visibleIf.always')}
            </button>
            <span className="schema-hint">
              {draft === null ? t('editor.visibleIf.clearHintNone') : t('editor.visibleIf.clearHint')}
            </span>
          </div>
          <button type="button" onClick={onClose} title={t('editor.visibleIf.cancelTitle')}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary" onClick={save} title={t('editor.visibleIf.saveTitle')}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

import { describe, it, expect } from 'vitest'
import {
  addEntryAt,
  buildTargets,
  canMoveEntry,
  describeVisibleIf,
  describeVisibleIfFull,
  kindLabel,
  moveEntryAt,
  moveEntryTo,
  pruneEmptyGroups,
  removeEntryAt,
  replaceEntryAt,
  setModeAt,
  targetLabel,
  whereLabel,
} from './VisibleIfDialog'
import type { EditorNode } from '../state/editorStore'
import type { VisibleIfSpec } from '../model/schema'

function node(name: string, patch: Partial<EditorNode> = {}): EditorNode {
  return {
    uid: `uid-${name}`,
    name,
    kind: 'string',
    min: 1,
    max: 1,
    description: '',
    options: [],
    required: false,
    visibleIf: null,
    children: [],
    ...patch,
  } as EditorNode
}

/** A small three-branch schema, used for the cross-branch target tests:
 *
 *     Relevant            (boolean, root)
 *     Findings            (group)
 *       Claim             (text)
 *       Outcomes          (group)
 *         Effect Size     (number)
 *     Notes               (text, root)
 */
const tree: EditorNode[] = [
  node('Relevant', { kind: 'boolean' }),
  node('Findings', {
    kind: 'group',
    children: [
      node('Claim'),
      node('Outcomes', {
        kind: 'group',
        children: [node('Effect Size', { kind: 'number' })],
      }),
    ],
  }),
  node('Notes'),
]

describe('describeVisibleIf', () => {
  it('no gate at all reads as always visible', () => {
    expect(describeVisibleIf(null)).toBe('Always visible')
    expect(describeVisibleIf({ mode: 'all', conditions: [] })).toBe('Always visible')
  })

  it('a lone "any answer" condition names the field', () => {
    expect(describeVisibleIf({ mode: 'all', conditions: [{ field: 'Relevant' }] })).toBe(
      'If "Relevant" has any answer',
    )
  })

  it('a boolean value condition spells out Yes/No rather than true/false', () => {
    expect(
      describeVisibleIf({ mode: 'all', conditions: [{ field: 'Relevant', equals: [true] }] }),
    ).toBe('If "Relevant" = Yes')
    expect(
      describeVisibleIf({ mode: 'all', conditions: [{ field: 'Relevant', equals: [false] }] }),
    ).toBe('If "Relevant" = No')
  })

  it('several values in one condition read as alternatives', () => {
    expect(
      describeVisibleIf({ mode: 'any', conditions: [{ field: 'Type', equals: ['RCT', 'Survey'] }] }),
    ).toBe('If "Type" = RCT or Survey')
  })

  it('two or more entries are counted, with the combining mode named', () => {
    const conditions = [{ field: 'a' }, { field: 'b' }, { field: 'c' }]
    expect(describeVisibleIf({ mode: 'all', conditions })).toBe('If all of 3 conditions')
    expect(describeVisibleIf({ mode: 'any', conditions })).toBe('If any of 3 conditions')
  })

  it('a nested group counts as one entry, and a lone one is looked through', () => {
    const inner: VisibleIfSpec = { mode: 'any', conditions: [{ field: 'a' }, { field: 'b' }] }
    expect(describeVisibleIf({ mode: 'all', conditions: [inner] })).toBe(
      'If any of 2 conditions',
    )
    expect(describeVisibleIf({ mode: 'all', conditions: [{ field: 'x' }, inner] })).toBe(
      'If all of 2 conditions',
    )
  })
})

describe('describeVisibleIfFull', () => {
  it('spells every condition out, joined by the mode word', () => {
    const conditions = [{ field: 'Relevant', equals: [true] }, { field: 'Type' }]
    expect(describeVisibleIfFull({ mode: 'all', conditions })).toBe(
      'Only shown if "Relevant" = Yes and "Type" has any answer.',
    )
    expect(describeVisibleIfFull({ mode: 'any', conditions })).toBe(
      'Only shown if "Relevant" = Yes or "Type" has any answer.',
    )
  })

  it('parenthesises a nested group so the nesting is unambiguous', () => {
    const spec: VisibleIfSpec = {
      mode: 'all',
      conditions: [
        { field: 'Relevant', equals: [true] },
        {
          mode: 'any',
          conditions: [{ field: 'Study Type', equals: ['RCT'] }, { field: 'Sample Size' }],
        },
      ],
    }
    expect(describeVisibleIfFull(spec)).toBe(
      'Only shown if "Relevant" = Yes and ("Study Type" = RCT or "Sample Size" has any answer).',
    )
  })

  it('nests to any depth', () => {
    const spec: VisibleIfSpec = {
      mode: 'any',
      conditions: [
        { field: 'a' },
        { mode: 'all', conditions: [{ field: 'b' }, { mode: 'any', conditions: [{ field: 'c' }] }] },
      ],
    }
    expect(describeVisibleIfFull(spec)).toBe(
      'Only shown if "a" has any answer or ("b" has any answer and ("c" has any answer)).',
    )
  })

  it('says so rather than rendering empty brackets for a group with nothing in it', () => {
    expect(
      describeVisibleIfFull({ mode: 'all', conditions: [{ mode: 'all', conditions: [] }] }),
    ).toBe('Only shown if (no conditions yet).')
  })

  it('no gate reads as always visible', () => {
    expect(describeVisibleIfFull(null)).toBe(
      'Always visible — this field/group is never hidden.',
    )
  })
})

describe('kindLabel', () => {
  it('names each kind of answer the way the reviewer sees it', () => {
    expect(kindLabel(node('a', { kind: 'boolean' }))).toBe('Yes/No')
    expect(kindLabel(node('a', { kind: 'number' }))).toBe('Number')
    expect(kindLabel(node('a', { kind: 'year' }))).toBe('Year')
    expect(kindLabel(node('a', { kind: 'string' }))).toBe('Free text')
    expect(kindLabel(node('a', { kind: 'string', options: ['x'] }))).toBe('Text, 1 fixed choice')
    expect(kindLabel(node('a', { kind: 'string', options: ['x', 'y', ' '] }))).toBe(
      'Text, 2 fixed choices',
    )
  })
})

describe('whereLabel', () => {
  it('distinguishes the same level, the parent and anything further up', () => {
    expect(whereLabel(0, null)).toBe('Same level')
    expect(whereLabel(1, null)).toBe('1 level up (parent)')
    expect(whereLabel(1, 'Findings')).toBe('1 level up (parent), in "Findings"')
    expect(whereLabel(3, 'Findings')).toBe('3 levels up, in "Findings"')
  })
})

describe('buildTargets', () => {
  it('siblings sit at the same level; ancestors get their distance and container', () => {
    const path = ['Findings', 'Evidence', 'Metric']
    const targets = buildTargets(
      [node('Other')],
      [node('Evidence'), node('Findings')],
      path,
      [],
      'uid-Metric',
    )
    expect(targets.map((t) => [t.node.name, t.levelsUp, t.container])).toEqual([
      ['Other', 0, null],
      ['Evidence', 1, 'Findings'],
      ['Findings', 2, null],
    ])
  })

  it('falls back to the chain order for an ancestor missing from the path', () => {
    const targets = buildTargets([], [node('Ghost')], ['Root', 'Me'], [], 'uid-Me')
    expect(targets[0].levelsUp).toBe(1)
    expect(targets[0].container).toBeNull()
  })

  it('lists same level, then ancestors, then the rest in document order', () => {
    // Gating "Claim": its sibling is the Outcomes group (not a target), and it
    // has no typed ancestor, so everything else comes from the third rank.
    const claim = (tree[1].children[0] as EditorNode)
    const targets = buildTargets([], [], ['Findings', 'Claim'], tree, claim.uid)
    expect(targets.map((t) => [t.group, t.value])).toEqual([
      ['elsewhere', 'Relevant'],
      ['elsewhere', 'Findings/Outcomes/Effect Size'],
      ['elsewhere', 'Notes'],
    ])
  })

  it('stores a bare name for a local target and an absolute path for the rest', () => {
    const effect = (tree[1].children[1] as EditorNode).children[0]
    const targets = buildTargets(
      [],
      [],
      ['Findings', 'Outcomes', 'Effect Size'],
      tree,
      effect.uid,
    )
    expect(targets.map((t) => t.value)).toEqual(['Relevant', 'Findings/Claim', 'Notes'])
    // A root-level field is a single-segment path, which reads as a bare name.
    expect(targets[0].path).toEqual(['Relevant'])
  })

  it('never offers the gated node itself, its subtree, or a group', () => {
    const targets = buildTargets([], [], ['Findings'], tree, tree[1].uid)
    expect(targets.map((t) => t.value)).toEqual(['Relevant', 'Notes'])
  })

  it('keeps a local target out of the third rank rather than listing it twice', () => {
    const notes = tree[2]
    const relevant = tree[0]
    const targets = buildTargets([notes], [relevant], ['Relevant', 'x'], tree, 'uid-x')
    expect(targets.map((t) => [t.group, t.value])).toEqual([
      ['same', 'Notes'],
      ['ancestor', 'Relevant'],
      ['elsewhere', 'Findings/Claim'],
      ['elsewhere', 'Findings/Outcomes/Effect Size'],
    ])
  })
})

describe('targetLabel', () => {
  it('says where the field lives and what it holds', () => {
    const targets = buildTargets(
      [node('Relevant', { kind: 'boolean' })],
      [node('Findings', { kind: 'boolean' })],
      ['Outcomes', 'Findings', 'Evidence', 'Me'],
      [],
      'uid-Me',
    )
    expect(targetLabel(targets[0])).toBe('Relevant — Same level · Yes/No')
    expect(targetLabel(targets[1])).toBe('Findings — 2 levels up, in "Outcomes" · Yes/No')
  })

  it('shows the whole path for a cross-branch field, which is what disambiguates it', () => {
    const effect = (tree[1].children[1] as EditorNode).children[0]
    const target = buildTargets([], [], ['Notes'], tree, 'uid-Notes').find(
      (t) => t.node.uid === effect.uid,
    )!
    expect(targetLabel(target)).toBe(
      'Findings / Outcomes / Effect Size — elsewhere in the schema · Number',
    )
  })
})

describe('entry helpers', () => {
  const spec: VisibleIfSpec = {
    mode: 'all',
    conditions: [{ field: 'a' }, { mode: 'any', conditions: [{ field: 'b' }, { field: 'c' }] }],
  }

  it('adds into the root group and into a nested one, by path', () => {
    expect(addEntryAt(spec, [], { field: 'z' }).conditions).toHaveLength(3)
    const nested = addEntryAt(spec, [1], { field: 'z' }).conditions[1] as VisibleIfSpec
    expect(nested.conditions.map((c) => (c as { field: string }).field)).toEqual(['b', 'c', 'z'])
  })

  it('replaces and removes a nested entry without touching its siblings', () => {
    const replaced = replaceEntryAt(spec, [1, 0], { field: 'b', equals: ['x'] })
    expect((replaced.conditions[1] as VisibleIfSpec).conditions[0]).toEqual({
      field: 'b',
      equals: ['x'],
    })
    expect(replaced.conditions[0]).toBe(spec.conditions[0])

    const removed = removeEntryAt(spec, [1, 0])
    expect((removed.conditions[1] as VisibleIfSpec).conditions).toEqual([{ field: 'c' }])
  })

  it('sets the mode of the root group or of a nested one', () => {
    expect(setModeAt(spec, [], 'any').mode).toBe('any')
    expect((setModeAt(spec, [1], 'all').conditions[1] as VisibleIfSpec).mode).toBe('all')
    // The nested group's own mode is untouched by a root-level change.
    expect((setModeAt(spec, [], 'any').conditions[1] as VisibleIfSpec).mode).toBe('any')
  })

  it('reorders within a group, a nested group included, and stops at the ends', () => {
    // A group moves as one entry, carrying its own conditions and mode.
    const swapped = moveEntryAt(spec, [1], -1)
    expect(swapped.conditions[0]).toEqual(spec.conditions[1])
    expect(swapped.conditions[1]).toEqual(spec.conditions[0])

    const inner = moveEntryAt(spec, [1, 1], -1).conditions[1] as VisibleIfSpec
    expect(inner.conditions).toEqual([{ field: 'c' }, { field: 'b' }])

    // Off either end is a no-op, so a stuck button cannot corrupt the gate.
    expect(moveEntryAt(spec, [0], -1)).toEqual(spec)
    expect(moveEntryAt(spec, [1], 1)).toEqual(spec)
  })

  it('never mutates the spec it was given', () => {
    const before = JSON.stringify(spec)
    addEntryAt(spec, [1], { field: 'z' })
    removeEntryAt(spec, [1, 0])
    replaceEntryAt(spec, [0], { field: 'q' })
    setModeAt(spec, [1], 'all')
    moveEntryAt(spec, [1], -1)
    moveEntryAt(spec, [1, 0], 1)
    expect(JSON.stringify(spec)).toBe(before)
  })

  it('leaves the spec alone for a path that is not a group', () => {
    expect(addEntryAt(spec, [0, 0], { field: 'z' })).toBe(spec)
  })
})

describe('canMoveEntry', () => {
  it('refuses the root group, and anything beside it', () => {
    expect(canMoveEntry([], [0], 'before')).toBe(false)
    expect(canMoveEntry([0], [], 'before')).toBe(false)
    expect(canMoveEntry([0], [], 'after')).toBe(false)
    // Into the root group is the way back out to the top level.
    expect(canMoveEntry([0], [], 'inside')).toBe(true)
  })

  it('refuses a group into itself or into its own descendant', () => {
    expect(canMoveEntry([1], [1], 'inside')).toBe(false)
    expect(canMoveEntry([1], [1, 0], 'inside')).toBe(false)
    expect(canMoveEntry([1], [1, 0], 'before')).toBe(false)
    expect(canMoveEntry([1], [1, 0, 2], 'after')).toBe(false)
    // A cousin's subtree is fine — it is not below the dragged entry.
    expect(canMoveEntry([1], [0, 0], 'before')).toBe(true)
  })

  it('refuses landing beside itself, which changes nothing', () => {
    expect(canMoveEntry([1, 0], [1, 0], 'before')).toBe(false)
    expect(canMoveEntry([1, 0], [1, 0], 'after')).toBe(false)
  })
})

describe('moveEntryTo', () => {
  /** `a`, a two-condition OR group, and an empty group. */
  const spec: VisibleIfSpec = {
    mode: 'all',
    conditions: [
      { field: 'a' },
      { mode: 'any', conditions: [{ field: 'b' }, { field: 'c' }] },
      { mode: 'all', conditions: [] },
    ],
  }

  it('moves a condition into another group, and back out to the root', () => {
    const into = moveEntryTo(spec, [0], [1], 'inside')
    expect(into.conditions[0]).toEqual({
      mode: 'any',
      conditions: [{ field: 'b' }, { field: 'c' }, { field: 'a' }],
    })
    expect(into.conditions).toHaveLength(2)

    const out = moveEntryTo(spec, [1, 0], [], 'inside')
    expect(out.conditions).toEqual([
      { field: 'a' },
      { mode: 'any', conditions: [{ field: 'c' }] },
      { mode: 'all', conditions: [] },
      { field: 'b' },
    ])
  })

  it('moves a condition into an empty group', () => {
    const moved = moveEntryTo(spec, [0], [2], 'inside')
    expect(moved.conditions).toEqual([
      { mode: 'any', conditions: [{ field: 'b' }, { field: 'c' }] },
      { mode: 'all', conditions: [{ field: 'a' }] },
    ])
  })

  it('moves a whole group, carrying its conditions and its own mode', () => {
    const moved = moveEntryTo(spec, [1], [2], 'inside')
    expect(moved.conditions).toEqual([
      { field: 'a' },
      {
        mode: 'all',
        conditions: [{ mode: 'any', conditions: [{ field: 'b' }, { field: 'c' }] }],
      },
    ])
  })

  it('reorders within one group through before/after', () => {
    expect(moveEntryTo(spec, [2], [0], 'before').conditions.map(kind)).toEqual([
      'group',
      'a',
      'group',
    ])
    const inner = moveEntryTo(spec, [1, 1], [1, 0], 'before').conditions[1] as VisibleIfSpec
    expect(inner.conditions).toEqual([{ field: 'c' }, { field: 'b' }])
  })

  it('accounts for the slot the entry vacated when both ends share a parent', () => {
    // "before the empty group" is index 2 before the move and index 1 after it.
    expect(moveEntryTo(spec, [0], [2], 'before').conditions.map(kind)).toEqual([
      'group',
      'a',
      'group',
    ])
    expect(moveEntryTo(spec, [0], [2], 'after').conditions.map(kind)).toEqual([
      'group',
      'group',
      'a',
    ])
  })

  it('accounts for it in the destination path too, not only in the slot', () => {
    // The OR group sits at [1] before the move and at [0] after it.
    const moved = moveEntryTo(spec, [0], [1, 1], 'after')
    expect(moved.conditions[0]).toEqual({
      mode: 'any',
      conditions: [{ field: 'b' }, { field: 'c' }, { field: 'a' }],
    })
  })

  it('hands the very same spec back for every move it refuses', () => {
    expect(moveEntryTo(spec, [1], [1, 0], 'before')).toBe(spec)
    expect(moveEntryTo(spec, [1], [1], 'inside')).toBe(spec)
    expect(moveEntryTo(spec, [], [0], 'after')).toBe(spec)
    expect(moveEntryTo(spec, [0], [], 'before')).toBe(spec)
    // "Inside" a condition is meaningless: it holds nothing.
    expect(moveEntryTo(spec, [1], [0], 'inside')).toBe(spec)
    // A path that leads nowhere.
    expect(moveEntryTo(spec, [9], [0], 'before')).toBe(spec)
  })

  it('never mutates the spec it was given', () => {
    const before = JSON.stringify(spec)
    moveEntryTo(spec, [0], [1], 'inside')
    moveEntryTo(spec, [1, 0], [], 'inside')
    moveEntryTo(spec, [1], [2], 'inside')
    moveEntryTo(spec, [0], [2], 'after')
    expect(JSON.stringify(spec)).toBe(before)
  })
})

/** An entry named for the assertions above: a condition's field, or "group". */
function kind(entry: VisibleIfSpec['conditions'][number]): string {
  return 'field' in entry ? entry.field : 'group'
}

describe('pruneEmptyGroups', () => {
  it('drops a group with nothing in it', () => {
    const spec: VisibleIfSpec = {
      mode: 'all',
      conditions: [{ field: 'a' }, { mode: 'any', conditions: [] }],
    }
    expect(pruneEmptyGroups(spec)).toEqual({ mode: 'all', conditions: [{ field: 'a' }] })
  })

  it('drops a group left empty by pruning, and the gate once nothing is left', () => {
    const spec: VisibleIfSpec = {
      mode: 'all',
      conditions: [{ mode: 'any', conditions: [{ mode: 'all', conditions: [] }] }],
    }
    expect(pruneEmptyGroups(spec)).toBeNull()
    expect(pruneEmptyGroups(null)).toBeNull()
  })

  it('keeps a gate that says something untouched', () => {
    const spec: VisibleIfSpec = {
      mode: 'any',
      conditions: [{ field: 'a' }, { mode: 'all', conditions: [{ field: 'b' }] }],
    }
    expect(pruneEmptyGroups(spec)).toEqual(spec)
  })
})

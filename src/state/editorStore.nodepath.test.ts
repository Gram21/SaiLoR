import { describe, it, expect } from 'vitest'
import { nodePathNames, parentUidOf, type EditorNode } from './editorStore'

/**
 * These two back the schema editor's drag-move guard. The distinction that
 * matters is reorder vs re-parent: answers are keyed by name at each level and
 * never by position, so sliding a field past its sibling must stay silent while
 * dragging it into a group must not.
 */

function n(uid: string, name: string, children: EditorNode[] = []): EditorNode {
  return {
    uid,
    name,
    kind: 'string',
    min: 0,
    max: 1,
    description: '',
    options: [],
    required: false,
    visibleIf: '',
    collapsed: false,
    children,
  } as EditorNode
}

const tree = [
  n('a', 'Study Type'),
  n('b', 'Findings', [n('c', 'Claim'), n('d', 'Evidence', [n('e', 'Metric')])]),
]

describe('nodePathNames', () => {
  it('names the path from the root down', () => {
    expect(nodePathNames(tree, 'a')).toEqual(['Study Type'])
    expect(nodePathNames(tree, 'c')).toEqual(['Findings', 'Claim'])
    expect(nodePathNames(tree, 'e')).toEqual(['Findings', 'Evidence', 'Metric'])
  })

  it('returns null for a uid that is not in the tree', () => {
    expect(nodePathNames(tree, 'nope')).toBeNull()
  })
})

describe('parentUidOf', () => {
  it('returns null for a root-level node and the uid otherwise', () => {
    expect(parentUidOf(tree, 'a')).toBeNull()
    expect(parentUidOf(tree, 'c')).toBe('b')
    expect(parentUidOf(tree, 'e')).toBe('d')
  })

  it('distinguishes "at the root" from "not present"', () => {
    // null and undefined mean different things here, and the guard branches on
    // it: a root-level node legitimately has no parent, while an unknown uid
    // means we cannot reason about the move and must not claim it is safe.
    expect(parentUidOf(tree, 'a')).toBeNull()
    expect(parentUidOf(tree, 'nope')).toBeUndefined()
  })

  it('reports the same parent for siblings, which is what makes a reorder silent', () => {
    expect(parentUidOf(tree, 'c')).toBe(parentUidOf(tree, 'd'))
  })
})

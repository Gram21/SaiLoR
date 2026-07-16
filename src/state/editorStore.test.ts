import { describe, it, expect } from 'vitest'
import {
  toAnnotationDefs,
  fromAnnotationDefs,
  moveNodeIn,
  isSelfOrDescendant,
  validateDraft,
  buildProjectJson,
  editorStateFromOpened,
  makePaperFromPdf,
  makeNode,
  useEditorStore,
  type EditorNode,
  type EditorPaper,
} from './editorStore'
import { loadProject } from '../model/project'
import type { OpenedProject } from '../platform'

function node(name: string, patch: Partial<EditorNode> = {}): EditorNode {
  return { ...makeNode(), name, ...patch }
}

function draft(nodes: EditorNode[], papers: EditorPaper[] = [], aiEnabled = true) {
  return { version: 1, aiEnabled, extra: {}, nodes, papers }
}

describe('schema conversion', () => {
  it('omits defaults and emits only what the on-disk shape needs', () => {
    const defs = toAnnotationDefs([
      node('Relevant', { kind: 'boolean' }),
      node('Findings', {
        kind: 'group',
        min: 1,
        max: null,
        description: 'What was found',
        children: [node('Claim', { kind: 'string' })],
      }),
    ])
    // min/max of 1 are the defaults, so they are not written.
    expect(defs[0]).toEqual({ name: 'Relevant', type: 'boolean' })
    expect(defs[1]).toEqual({
      name: 'Findings',
      max: null,
      description: 'What was found',
      children: [{ name: 'Claim', type: 'string' }],
    })
    // A group carries no `type`.
    expect(defs[1].type).toBeUndefined()
  })

  it('keeps enum options only on string fields', () => {
    const withOpts = toAnnotationDefs([node('Kind', { kind: 'string', options: ['a', 'b'] })])
    expect(withOpts[0].options).toEqual(['a', 'b'])
    // A number field must not carry options (the model rejects that).
    const numeric = toAnnotationDefs([node('Year', { kind: 'number', options: ['a'] })])
    expect(numeric[0].options).toBeUndefined()
  })

  it('round-trips through the on-disk shape', () => {
    const original = [
      node('Relevant', { kind: 'boolean' }),
      node('Evidence', {
        kind: 'group',
        max: null,
        children: [node('Type', { kind: 'string', options: ['case study', 'experiment'] })],
      }),
    ]
    const back = fromAnnotationDefs(toAnnotationDefs(original))
    expect(toAnnotationDefs(back)).toEqual(toAnnotationDefs(original))
  })

  it('round-trips required, and never writes it for a group', () => {
    const defs = toAnnotationDefs([
      node('Relevant', { kind: 'boolean', required: true }),
      node('Notes', { kind: 'string' }),
      node('Findings', { kind: 'group', required: true, children: [node('Claim', { kind: 'string' })] }),
    ])
    expect(defs[0].required).toBe(true)
    expect(defs[1].required).toBeUndefined()
    expect(defs[2].required).toBeUndefined()

    const back = fromAnnotationDefs(defs)
    expect(back[0].required).toBe(true)
    expect(back[1].required).toBe(false)
    expect(toAnnotationDefs(back)).toEqual(defs)
  })
})

describe('updateNode', () => {
  it('clears required when a field becomes a group', () => {
    const field = node('Relevant', { kind: 'boolean', required: true })
    useEditorStore.setState({ nodes: [field] })
    useEditorStore.getState().updateNode(field.uid, { kind: 'group' })
    expect(useEditorStore.getState().nodes[0].required).toBe(false)
  })
})

describe('moveNodeIn', () => {
  it('reorders siblings', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const [a, , c] = nodes
    expect(moveNodeIn(nodes, c.uid, a.uid, 'before')).toBe(true)
    expect(nodes.map((n) => n.name)).toEqual(['C', 'A', 'B'])
  })

  it('nests a node inside another (drop "inside")', () => {
    const nodes = [node('Parent'), node('Child')]
    const [parent, child] = nodes
    expect(moveNodeIn(nodes, child.uid, parent.uid, 'inside')).toBe(true)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].children.map((n) => n.name)).toEqual(['Child'])
  })

  it('lifts a nested node back out to the top level', () => {
    const child = node('Child')
    const nodes = [node('Parent', { children: [child] }), node('Other')]
    expect(moveNodeIn(nodes, child.uid, nodes[1].uid, 'after')).toBe(true)
    expect(nodes.map((n) => n.name)).toEqual(['Parent', 'Other', 'Child'])
    expect(nodes[0].children).toHaveLength(0)
  })

  it('refuses to drop a node into itself or its own subtree', () => {
    const grandchild = node('Grandchild')
    const child = node('Child', { children: [grandchild] })
    const nodes = [node('Parent', { children: [child] })]
    const parent = nodes[0]

    expect(isSelfOrDescendant(nodes, parent.uid, grandchild.uid)).toBe(true)
    // Dropping the parent into its own grandchild would detach the subtree.
    expect(moveNodeIn(nodes, parent.uid, grandchild.uid, 'inside')).toBe(false)
    expect(moveNodeIn(nodes, parent.uid, parent.uid, 'after')).toBe(false)
    // The tree is untouched.
    expect(nodes).toHaveLength(1)
    expect(nodes[0].children[0].children[0].name).toBe('Grandchild')
  })
})

describe('validateDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(validateDraft(draft([node('Relevant', { kind: 'boolean' })]))).toEqual([])
  })

  it('requires at least one field', () => {
    expect(validateDraft(draft([]))[0]).toMatch(/at least one field/i)
  })

  it('reports unnamed fields', () => {
    expect(validateDraft(draft([node('')]))[0]).toMatch(/no name/i)
  })

  it('reports duplicate sibling names via the model resolver', () => {
    const issues = validateDraft(draft([node('Dup'), node('Dup')]))
    expect(issues.join(' ')).toMatch(/duplicate sibling/i)
  })

  it('reports max < min', () => {
    const issues = validateDraft(draft([node('X', { min: 3, max: 2 })]))
    expect(issues.join(' ')).toMatch(/max .* must be >= min/i)
  })

  it('reports duplicate paper ids and missing fields', () => {
    const papers: EditorPaper[] = [
      makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set()),
      makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set()),
    ]
    const issues = validateDraft(draft([node('X', { kind: 'string' })], papers))
    expect(issues.join(' ')).toMatch(/duplicate paper id/i)
  })

  it('reports a paper with no PDF attached as a clear per-paper issue, not a schema error', () => {
    // A reference-import row before the user has attached a PDF: everything
    // else is filled in, only `pdf` is empty — the draft must tolerate that
    // (it is not written to disk this way; save() blocks on this issue).
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.pdf = ''
    const issues = validateDraft(draft([node('X', { kind: 'string' })], [paper]))
    expect(issues).toEqual(['Paper 1 has no PDF attached.'])
  })
})

describe('makePaperFromPdf', () => {
  it('derives a slug id and a readable title, avoiding collisions', () => {
    const ids = new Set<string>()
    const first = makePaperFromPdf('My_Great Paper.pdf', 'pdfs/My_Great Paper.pdf', '/abs/x.pdf', ids)
    expect(first.id).toBe('my-great-paper')
    expect(first.title).toBe('My Great Paper')
    expect(first.pdf).toBe('pdfs/My_Great Paper.pdf')
    expect(first.sourcePath).toBe('/abs/x.pdf')

    ids.add(first.id)
    const second = makePaperFromPdf('My_Great Paper.pdf', 'b.pdf', undefined, ids)
    expect(second.id).toBe('my-great-paper-2')
  })
})

describe('buildProjectJson', () => {
  it('produces a file the real loader accepts', () => {
    const papers = [makePaperFromPdf('paper-a.pdf', 'pdfs/paper-a.pdf', undefined, new Set())]
    papers[0].authors = 'A. Author, B. Writer'
    papers[0].doi = '10.1000/xyz'
    const json = buildProjectJson(
      draft(
        [
          node('Relevant', { kind: 'boolean' }),
          node('Findings', { kind: 'group', max: null, children: [node('Claim', { kind: 'string' })] }),
        ],
        papers,
      ),
    )

    const project = loadProject(JSON.stringify(json))
    expect(project.papers[0].authors).toEqual(['A. Author', 'B. Writer'])
    expect(project.papers[0].doi).toBe('10.1000/xyz')
    expect(project.papers[0].pdf).toBe('pdfs/paper-a.pdf')
    expect(project.schema.map((d) => d.name)).toEqual(['Relevant', 'Findings'])
    expect(project.schema[1].max).toBeNull()
  })

  it('preserves existing annotations verbatim while the schema is edited', () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    paper.annotations = { Relevant: [{ value: true }] }
    const json = buildProjectJson(draft([node('Relevant', { kind: 'boolean' })], [paper]))
    const out = (json.papers as Record<string, unknown>[])[0]
    expect(out.annotations).toEqual({ Relevant: [{ value: true }] })
  })

  it('omits an empty doi rather than writing an empty string', () => {
    const paper = makePaperFromPdf('a.pdf', 'a.pdf', undefined, new Set())
    const json = buildProjectJson(draft([node('X', { kind: 'string' })], [paper]))
    const out = (json.papers as Record<string, unknown>[])[0]
    expect('doi' in out).toBe(false)
  })

  it('writes config.ai only when the editor disabled it', () => {
    const nodes = [node('X', { kind: 'string' })]
    const on = buildProjectJson(draft(nodes, [], true)).config as Record<string, unknown>
    expect('ai' in on).toBe(false)

    const off = buildProjectJson(draft(nodes, [], false)).config as Record<string, unknown>
    expect(off.ai).toBe(false)

    // The loader reads back what the editor wrote.
    expect(loadProject(JSON.stringify(buildProjectJson(draft(nodes, [], false)))).aiEnabled).toBe(false)
  })
})

describe('editorStateFromOpened (shared by "Edit annotation JSON…" and the recents pen)', () => {
  const opened = (text: string): OpenedProject => ({
    text,
    name: 'review.json',
    handle: { kind: 'fsapi', path: '/x/review.json' } as OpenedProject['handle'],
  })

  const projectJson = JSON.stringify({
    version: 2,
    title: 'My Review',
    reviewers: ['A'], // an unknown top-level key, must be preserved as extra
    config: {
      schema: [
        { name: 'Relevant', type: 'boolean' },
        { name: 'Findings', max: null, children: [{ name: 'Claim', type: 'string' }] },
      ],
    },
    papers: [
      { id: 'p1', title: 'Paper One', authors: ['A. Author'], pdf: 'pdfs/p1.pdf', annotations: {} },
    ],
  })

  it('turns a project file into editor nodes, papers, title and preserved extras', () => {
    const st = editorStateFromOpened(opened(projectJson))
    expect(st.version).toBe(2)
    expect(st.title).toBe('My Review')
    // No config.ai in the file: AI stays enabled by default.
    expect(st.aiEnabled).toBe(true)
    expect(st.extra).toEqual({ reviewers: ['A'] })
    expect(st.location).toMatchObject({ name: 'review.json', path: '/x/review.json' })
    expect(st.nodes.map((n) => n.name)).toEqual(['Relevant', 'Findings'])
    expect(st.nodes[1].children.map((c) => c.name)).toEqual(['Claim'])
    expect(st.papers).toHaveLength(1)
    expect(st.papers[0].authors).toBe('A. Author')

    // The parsed draft rebuilds a file the real loader still accepts.
    const roundTrip = loadProject(JSON.stringify(buildProjectJson(st)))
    expect(roundTrip.schema.map((d) => d.name)).toEqual(['Relevant', 'Findings'])
  })

  // Regression test: this path (opening an *existing* project into the editor,
  // via the file picker or the recents pen) once bypassed config.ai entirely,
  // silently leaving whatever aiEnabled the editor session previously had
  // rather than reading the file's own opt-out.
  it('reads config.ai: false from an opened project, not just a freshly built one', () => {
    const disabled = JSON.stringify({
      version: 1,
      config: { ai: false, schema: [{ name: 'Relevant', type: 'boolean' }] },
      papers: [],
    })
    const st = editorStateFromOpened(opened(disabled))
    expect(st.aiEnabled).toBe(false)

    const roundTrip = loadProject(JSON.stringify(buildProjectJson(st)))
    expect(roundTrip.aiEnabled).toBe(false)
  })

  it('throws on a structurally invalid project so the caller can show an error', () => {
    expect(() => editorStateFromOpened(opened('{ not json'))).toThrow()
    expect(() => editorStateFromOpened(opened(JSON.stringify({ papers: [] })))).toThrow()
  })
})

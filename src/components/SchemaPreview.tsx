// [impl->req~edt-310~1]
// [impl->req~edt-320~1]
import { useMemo, useState } from 'react'
import { produce } from 'immer'
import { useEditorStore, toAnnotationDefs, validateDraft } from '../state/editorStore'
import { containerAt } from '../state/store'
import { resolveSchema, type ResolvedDef } from '../model/schema'
import { isFieldVisible, makeInstance, normalizeTree, type AnnotationValueTree } from '../model/annotations'
import { duplicateOnWrite } from '../model/unique'
import { validatePaper } from '../model/validate'
import type { Paper } from '../model/project'
import { useT } from '../i18n'
import { AnnotationNode } from './AnnotationNode'
import { AnnotationFormContext, type AnnotationFormWrites } from './AnnotationFormContext'

/** The project editor's Preview tab: the annotation form for the draft schema,
 *  with its answers in local state only. Unmounting it (leaving the tab or
 *  closing the editor) discards them. */
export function SchemaPreview() {
  const t = useT()
  const nodes = useEditorStore((s) => s.nodes)
  const papers = useEditorStore((s) => s.papers)
  const [paperUid, setPaperUid] = useState<string | null>(null)
  const paper = papers.find((p) => p.uid === paperUid) ?? papers[0]

  const { schema, problems } = useMemo(() => {
    const st = useEditorStore.getState()
    const problems = validateDraft({ ...st, nodes, papers: [], strict: null })
    return { schema: problems.length === 0 ? resolveSchema(toAnnotationDefs(nodes)) : null, problems }
  }, [nodes])

  return (
    <div className="editor-preview">
      <p className="editor-preview-banner" role="status">
        {t('editor.preview.banner')}
      </p>
      {papers.length > 0 ? (
        <label className="editor-preview-paper">
          <span>{t('editor.preview.paper')}</span>
          <select value={paper?.uid} onChange={(e) => setPaperUid(e.target.value)}>
            {papers.map((p, i) => (
              <option key={p.uid} value={p.uid}>
                {p.title.trim() || p.id.trim() || t('editor.preview.untitled', { n: i + 1 })}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="editor-hint">{t('editor.preview.noPapers')}</p>
      )}
      {schema ? (
        <PreviewForm
          key={`${paper?.uid ?? ''}|${JSON.stringify(toAnnotationDefs(nodes))}`}
          schema={schema}
          paperId={paper?.id.trim() ?? ''}
          paperTitle={paper?.title.trim() ?? ''}
        />
      ) : (
        <div className="editor-issues" role="alert">
          <strong>{t('editor.preview.invalid')}</strong>
          <ul>
            {problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function PreviewForm({ schema, paperId, paperTitle }: { schema: ResolvedDef[]; paperId: string; paperTitle: string }) {
  const t = useT()
  const [tree, setTree] = useState<AnnotationValueTree>(() => normalizeTree(schema, undefined))

  const writes: AnnotationFormWrites = {
    setFieldValue: (path, name, index, value) => {
      const hint = duplicateOnWrite(schema, tree, [...path, { name, index }], value)
      if (hint) return hint
      setTree((prev) =>
        produce(prev, (draft) => {
          const inst = containerAt(draft, path)[name]?.[index]
          if (inst) inst.value = value
        }),
      )
      return null
    },
    addInstance: (path, def) =>
      setTree((prev) =>
        produce(prev, (draft) => {
          const list = containerAt(draft, path)[def.name]
          if (list && (def.max === null || list.length < def.max)) list.push(makeInstance(def))
        }),
      ),
    removeInstance: (path, name, index) =>
      setTree((prev) =>
        produce(prev, (draft) => {
          const list = containerAt(draft, path)[name]
          if (list && index >= 0 && index < list.length) list.splice(index, 1)
        }),
      ),
  }

  const issues = validatePaper(schema, { id: paperId, title: paperTitle, annotations: tree } as Paper)

  return (
    <div className="panel annotations editor-preview-form">
      <div className="annotations-head">
        <h2>{t('annotation.panel.title')}</h2>
        {paperTitle && <div className="annotations-paper-title">{paperTitle}</div>}
      </div>
      <div className="annotations-body">
        <AnnotationFormContext.Provider value={writes}>
          {schema
            .filter((def) => isFieldVisible(def, tree, {}, tree))
            .map((def) => (
              <AnnotationNode key={def.id} def={def} path={[]} container={tree} root={tree} />
            ))}
        </AnnotationFormContext.Provider>
      </div>
      {issues.length > 0 && (
        <div className="editor-preview-issues">
          <strong>{t('editor.preview.issues')}</strong>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

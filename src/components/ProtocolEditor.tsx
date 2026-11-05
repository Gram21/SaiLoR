import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../state/editorStore'
import type { ProjectProtocol } from '../model/project'
import { useT } from '../i18n'

/**
 * Authors the review's protocol — research questions, the search that ran, and
 * the criteria behind it — into `Project.protocol`. A first-class, durable
 * field, not a `config` key (which a save would strip): see `ProjectProtocol`.
 *
 * The list fields (questions, searches, databases) are edited as one-item-per-
 * line text rather than an add-a-row list like `ScreeningReasonsEditor`: a
 * reviewer usually pastes a block of research questions or query strings in one
 * go, and a textarea is far less friction for that than clicking "+ Add" per
 * line. That does mean the raw text is this component's own state, seeded from
 * the store and only re-seeded when the store's protocol changes for a reason
 * other than this editor's own typing (undo/redo, or opening another project) —
 * otherwise filtering blank lines on every keystroke would fight the cursor the
 * instant a reviewer pressed Enter to start the next item.
 */
type Fields = {
  researchQuestions: string
  searchStrings: string
  databases: string
  searchDate: string
  notes: string
}

// [impl->req~edt-70~1]
function fieldsFrom(protocol: ProjectProtocol | null): Fields {
  return {
    researchQuestions: (protocol?.researchQuestions ?? []).join('\n'),
    searchStrings: (protocol?.searchStrings ?? []).join('\n'),
    databases: (protocol?.databases ?? []).join('\n'),
    searchDate: protocol?.searchDate ?? '',
    notes: protocol?.notes ?? '',
  }
}

// [impl->req~edt-70~1]
function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Assemble a stored protocol from the raw fields, dropping every empty part —
 *  an all-empty protocol becomes `null`, so a reviewer who opens the section
 *  and types nothing never writes a stray `protocol: {}` into the file. */
function assemble(fields: Fields): ProjectProtocol | null {
  const p: ProjectProtocol = {}
  const rqs = linesToList(fields.researchQuestions)
  if (rqs.length) p.researchQuestions = rqs
  const searches = linesToList(fields.searchStrings)
  if (searches.length) p.searchStrings = searches
  const dbs = linesToList(fields.databases)
  if (dbs.length) p.databases = dbs
  const date = fields.searchDate.trim()
  if (date) p.searchDate = date
  const notes = fields.notes.trim()
  if (notes) p.notes = notes
  return Object.keys(p).length > 0 ? p : null
}

export function ProtocolEditor() {
  const t = useT()
  const protocol = useEditorStore((s) => s.protocol)
  const setProtocol = useEditorStore((s) => s.setProtocol)

  const [fields, setFields] = useState<Fields>(() => fieldsFrom(protocol))
  // The store value this editor last wrote. When the store's protocol is no
  // longer this object, something else changed it (undo/redo, a project just
  // opened) and the raw text must be re-seeded from it.
  const lastPushed = useRef<ProjectProtocol | null>(protocol)

  useEffect(() => {
    if (protocol !== lastPushed.current) {
      setFields(fieldsFrom(protocol))
      lastPushed.current = protocol
    }
  }, [protocol])

  const update = (patch: Partial<Fields>) => {
    const next = { ...fields, ...patch }
    setFields(next)
    const assembled = assemble(next)
    lastPushed.current = assembled
    setProtocol(assembled)
  }

  return (
    <div className="protocol-editor">
      <label className="protocol-field">
        <span className="protocol-field-label">{t('editor.protocol.researchQuestions')}</span>
        <textarea
          className="protocol-textarea"
          rows={3}
          value={fields.researchQuestions}
          placeholder={t('editor.protocol.researchQuestionsPlaceholder')}
          onChange={(e) => update({ researchQuestions: e.target.value })}
        />
      </label>

      <label className="protocol-field">
        <span className="protocol-field-label">{t('editor.protocol.searchStrings')}</span>
        <textarea
          className="protocol-textarea"
          rows={3}
          value={fields.searchStrings}
          placeholder={t('editor.protocol.searchStringsPlaceholder')}
          onChange={(e) => update({ searchStrings: e.target.value })}
        />
      </label>

      <label className="protocol-field">
        <span className="protocol-field-label">{t('editor.protocol.databases')}</span>
        <textarea
          className="protocol-textarea"
          rows={2}
          value={fields.databases}
          placeholder={t('editor.protocol.databasesPlaceholder')}
          onChange={(e) => update({ databases: e.target.value })}
        />
      </label>

      <label className="protocol-field">
        <span className="protocol-field-label">{t('editor.protocol.searchDate')}</span>
        <input
          className="protocol-input"
          type="text"
          value={fields.searchDate}
          placeholder={t('editor.protocol.searchDatePlaceholder')}
          onChange={(e) => update({ searchDate: e.target.value })}
        />
      </label>

      <label className="protocol-field">
        <span className="protocol-field-label">{t('editor.protocol.notes')}</span>
        <textarea
          className="protocol-textarea"
          rows={4}
          value={fields.notes}
          placeholder={t('editor.protocol.notesPlaceholder')}
          onChange={(e) => update({ notes: e.target.value })}
        />
      </label>
    </div>
  )
}

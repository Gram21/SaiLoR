import { useEditorStore } from '../state/editorStore'
import { SchemaTreeEditor } from './SchemaTreeEditor'
import { PapersEditor } from './PapersEditor'
import '../styles/editor.css'

/**
 * Full-screen editor for a project JSON: pick where it lives, build the
 * annotation schema, and attach the PDFs to annotate. Shown instead of the
 * annotation workspace while `open` is true.
 */
export function ProjectEditor() {
  const open = useEditorStore((s) => s.open)
  const mode = useEditorStore((s) => s.mode)
  const location = useEditorStore((s) => s.location)
  const dirty = useEditorStore((s) => s.dirty)
  const busy = useEditorStore((s) => s.busy)
  const error = useEditorStore((s) => s.error)
  const issues = useEditorStore((s) => s.issues)
  const notice = useEditorStore((s) => s.notice)
  const extracting = useEditorStore((s) => s.extracting)
  const changeLocation = useEditorStore((s) => s.changeLocation)
  const save = useEditorStore((s) => s.save)
  const close = useEditorStore((s) => s.close)
  const clearError = useEditorStore((s) => s.clearError)
  const clearNotice = useEditorStore((s) => s.clearNotice)

  if (!open) return null

  const onClose = () => {
    if (dirty && !window.confirm('Discard the unsaved changes to this project JSON?')) return
    close()
  }

  // The full path is the useful bit in Electron; in the browser only a name exists.
  const locationLabel = location ? (location.path ?? location.name) : 'Not set'

  return (
    <div className="editor">
      <div className="editor-head">
        <div className="editor-title">
          <strong>{mode === 'new' ? 'New annotation JSON' : 'Edit annotation JSON'}</strong>
          {dirty && <span className="editor-dirty" title="Unsaved changes">●</span>}
        </div>
        <div className="editor-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save JSON'}
          </button>
        </div>
      </div>

      <div className="editor-location">
        <span className="editor-location-label">JSON file</span>
        <code className="editor-location-path" title={locationLabel}>
          {locationLabel}
        </code>
        <button type="button" onClick={() => void changeLocation()} disabled={busy}>
          Change…
        </button>
      </div>

      {error && (
        <div className="editor-error" role="alert">
          <div className="editor-error-head">
            <strong>{error.message}</strong>
            <button type="button" className="icon-btn" onClick={clearError} aria-label="Dismiss">
              ×
            </button>
          </div>
          {error.details.length > 0 && (
            <ul>
              {error.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {issues.length > 0 && (
        <div className="editor-issues" role="alert">
          <strong>Fix these before saving:</strong>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="editor-body">
        <section className="editor-section">
          <h2>Annotation schema</h2>
          <p className="editor-hint">
            The fields reviewers fill in for each paper. A <em>Group</em> holds nested fields; set
            an unbounded maximum to let a field repeat. Drag rows to reorder or to nest them.
          </p>
          <SchemaTreeEditor />
        </section>

        <section className="editor-section">
          <h2>Papers</h2>
          <p className="editor-hint">
            PDFs are referenced relative to the JSON file, so moving the JSON re-derives their
            paths. A PDF already in the project is not added twice, and the title and authors are
            read from the PDF where possible.
          </p>
          {notice && (
            <div className="editor-notice">
              <span>{notice}</span>
              <button type="button" className="icon-btn" onClick={clearNotice} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
          {extracting > 0 && (
            <p className="editor-hint" role="status">
              Reading {extracting} PDF{extracting === 1 ? '' : 's'} for title and authors…
            </p>
          )}
          <PapersEditor />
        </section>
      </div>
    </div>
  )
}

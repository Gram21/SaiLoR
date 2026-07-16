import { useEditorStore } from '../state/editorStore'
import { getPlatform } from '../platform'
import { SchemaTreeEditor } from './SchemaTreeEditor'
import { ScreeningReasonsEditor } from './ScreeningReasonsEditor'
import { PapersEditor } from './PapersEditor'
import '../styles/editor.css'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = getPlatform().kind === 'electron' && isMac ? '⌘' : 'Ctrl'

/**
 * Full-screen editor for a project JSON: pick where it lives, build the
 * annotation schema, and attach the PDFs to annotate. Shown instead of the
 * annotation workspace while `open` is true.
 */
export function ProjectEditor() {
  const open = useEditorStore((s) => s.open)
  const mode = useEditorStore((s) => s.mode)
  const location = useEditorStore((s) => s.location)
  const title = useEditorStore((s) => s.title)
  const setTitle = useEditorStore((s) => s.setTitle)
  const aiEnabled = useEditorStore((s) => s.aiEnabled)
  const setAiEnabled = useEditorStore((s) => s.setAiEnabled)
  const reviewers = useEditorStore((s) => s.reviewers)
  const setReviewers = useEditorStore((s) => s.setReviewers)
  const screening = useEditorStore((s) => s.screening)
  const setScreening = useEditorStore((s) => s.setScreening)
  const dirty = useEditorStore((s) => s.dirty)
  const busy = useEditorStore((s) => s.busy)
  const error = useEditorStore((s) => s.error)
  const issues = useEditorStore((s) => s.issues)
  const notice = useEditorStore((s) => s.notice)
  const extracting = useEditorStore((s) => s.extracting)
  const changeLocation = useEditorStore((s) => s.changeLocation)
  const save = useEditorStore((s) => s.save)
  const saveAndAnnotate = useEditorStore((s) => s.saveAndAnnotate)
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
  const multiReviewer = reviewers > 1

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
          <button type="button" onClick={() => void save()} disabled={busy} title={`Save (${MOD}+S)`}>
            {busy ? 'Saving…' : 'Save JSON'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void saveAndAnnotate()}
            disabled={busy}
          >
            Save JSON &amp; Begin Annotating
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

      <div className="editor-location">
        <span className="editor-location-label">Project title</span>
        <input
          className="editor-title-input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Optional — shown instead of "${location?.name ?? 'the file name'}"`}
          disabled={busy}
        />
      </div>

      <div className="editor-location">
        <span className="editor-location-label">AI annotation</span>
        <label className="editor-ai-toggle" title="Uncheck to disable AI-assisted annotation for anyone who opens this project. Writes config.ai: false into the JSON.">
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(e) => setAiEnabled(e.target.checked)}
            disabled={busy}
          />
          <span>Allow reviewers to use AI-assisted annotation</span>
        </label>
      </div>

      <div className="editor-location">
        <span className="editor-location-label">Screening</span>
        <label
          className="editor-ai-toggle"
          title="A screening project records one include/exclude decision per paper instead of an annotation schema. Writes config.screening into the JSON."
        >
          <input
            type="checkbox"
            checked={screening !== null}
            onChange={(e) => setScreening(e.target.checked)}
            disabled={busy}
          />
          <span>This is a screening project</span>
        </label>
      </div>
      {screening && (
        <p className="editor-hint editor-screening-hint">
          Screening records one <strong>Include / Exclude</strong> decision per paper — a two-option
          choice, not a checkbox, because the app also has to be able to say "not screened yet". The
          exclusion reasons below are fixed up front, the way a review protocol pre-registers them, so
          the counts can be reported per reason.
        </p>
      )}

      <div className="editor-location">
        <span className="editor-location-label">Reviewers</span>
        <label
          className="editor-ai-toggle"
          title="Enable to have multiple people annotate every paper independently, then reconcile disagreements into one final answer."
        >
          <input
            type="checkbox"
            checked={multiReviewer}
            onChange={(e) => setReviewers(e.target.checked ? 2 : 1)}
            disabled={busy}
          />
          <span>Multiple independent reviewers</span>
        </label>
        {multiReviewer && (
          <input
            className="editor-reviewers-input"
            type="number"
            min={2}
            max={10}
            value={reviewers}
            onChange={(e) => setReviewers(Number(e.target.value) || 2)}
            disabled={busy}
          />
        )}
      </div>
      {multiReviewer && (
        <p className="editor-hint editor-reviewers-hint">
          Each of the {reviewers} reviewers annotates independently and only sees their own
          work. In addition to them, there is always one extra <strong>Consolidation</strong>{' '}
          reviewer, who compares everyone's answers and records the final, agreed result — that
          consolidated result is what the project's saved output actually contains.
        </p>
      )}

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
        {screening ? (
          <section className="editor-section">
            <h2>Exclusion reasons</h2>
            <p className="editor-hint">
              Why a paper is excluded. Reviewers pick one of these when they exclude a paper — there is
              no free-text option, so the counts this project reports per reason stay meaningful.
            </p>
            <ScreeningReasonsEditor />
          </section>
        ) : (
          <section className="editor-section">
            <h2>Annotation schema</h2>
            <p className="editor-hint">
              The fields reviewers fill in for each paper. A <em>Group</em> holds nested fields; set
              an unbounded maximum to let a field repeat. Drag rows to reorder or to nest them.
            </p>
            <SchemaTreeEditor />
          </section>
        )}

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

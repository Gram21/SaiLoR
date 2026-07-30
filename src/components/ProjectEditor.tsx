import { useEditorStore } from '../state/editorStore'
import { getPlatform } from '../platform'
import { SchemaTreeEditor } from './SchemaTreeEditor'
import { ScreeningReasonsEditor } from './ScreeningReasonsEditor'
import { ProtocolEditor } from './ProtocolEditor'
import { PapersEditor } from './PapersEditor'
import type { ProjectProvenance } from '../model/project'
import '../styles/editor.css'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = getPlatform().kind === 'electron' && isMac ? '⌘' : 'Ctrl'

/** Issues stay a flat string list (`validateDraft` in editorStore.ts) rather
 *  than structured per-paper objects, so a "Paper N: …" line is recognized by
 *  its leading number instead — enough to jump to it without reshaping the
 *  validator just for this. */
const ISSUE_PAPER_PREFIX = /^Paper (\d+)/
/** Past this many, the list stops rendering the rest inline — at a few
 *  hundred papers `validateDraft` emits one line per paper, which otherwise
 *  pushes the whole editor off-screen (see PapersEditor.tsx / #82). */
const ISSUE_DISPLAY_LIMIT = 12

/**
 * Full-screen editor for a project JSON: pick where it lives, build the
 * annotation schema, and attach the PDFs to annotate. Shown instead of the
 * annotation workspace while `open` is true.
 *
 * No AI-annotation toggle here on purpose: with no reachable entry point for
 * the feature itself (see `aiUnlocked` in store.ts), offering a control that
 * configures it would promise something the app doesn't currently deliver.
 * `EditorState.aiEnabled` still exists and defaults to `false` for a new
 * project (see the initial state / `startNew` in editorStore.ts), and an
 * existing file's own `config.ai` is still read and preserved on save —
 * there just isn't a way to change it from here right now.
 */
export function ProjectEditor() {
  const open = useEditorStore((s) => s.open)
  const mode = useEditorStore((s) => s.mode)
  const location = useEditorStore((s) => s.location)
  const title = useEditorStore((s) => s.title)
  const setTitle = useEditorStore((s) => s.setTitle)
  const reviewers = useEditorStore((s) => s.reviewers)
  const setReviewers = useEditorStore((s) => s.setReviewers)
  const screening = useEditorStore((s) => s.screening)
  const setScreening = useEditorStore((s) => s.setScreening)
  const provenance = useEditorStore((s) => s.provenance)
  const protocol = useEditorStore((s) => s.protocol)
  const schemaInfo = useEditorStore((s) => s.schemaInfo)
  const setSchemaInfo = useEditorStore((s) => s.setSchemaInfo)
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

  // "Paper N: …" issues carry which row they're about; scroll to and focus
  // it in the (always-visible, never-modal) Papers section below.
  const jumpToPaper = (index: number) => {
    const row = document.getElementById(`papers-row-${index}`)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    row.querySelector<HTMLInputElement>('input')?.focus()
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

      {provenance && <ProvenanceNote provenance={provenance} />}

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
            {issues.slice(0, ISSUE_DISPLAY_LIMIT).map((issue, i) => {
              const m = ISSUE_PAPER_PREFIX.exec(issue)
              return (
                <li key={i}>
                  {m ? (
                    <button
                      type="button"
                      className="editor-issue-jump"
                      onClick={() => jumpToPaper(Number(m[1]) - 1)}
                    >
                      {issue}
                    </button>
                  ) : (
                    issue
                  )}
                </li>
              )
            })}
          </ul>
          {issues.length > ISSUE_DISPLAY_LIMIT && (
            <p className="editor-issues-more">…and {issues.length - ISSUE_DISPLAY_LIMIT} more.</p>
          )}
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
          {/* Collapsed by default: optional, and most projects that use it set
              it once at the start and rarely reopen it — but open on its own
              when the project already has a protocol, so an existing one is
              never hidden behind a closed disclosure the reviewer must know to
              expand. */}
          <details className="editor-protocol-details" open={protocol !== null}>
            <summary>
              <h2>Review protocol</h2>
              <span className="editor-protocol-summary-hint">
                {protocol ? 'recorded' : 'optional'}
              </span>
            </summary>
            <p className="editor-hint">
              The review's research questions, the search behind it, and its inclusion/exclusion
              criteria — recorded inside the project so a pre-registered protocol travels with the
              data it produced. Every field is optional.
            </p>
            <ProtocolEditor />
          </details>
        </section>

        <section className="editor-section">
          {/* Same "open when already recorded" rule as the protocol section
              above, for the same reason. */}
          <details className="editor-protocol-details" open={schemaInfo !== null}>
            <summary>
              <h2>Schema info</h2>
              <span className="editor-protocol-summary-hint">
                {schemaInfo ? 'recorded' : 'optional'}
              </span>
            </summary>
            <p className="editor-hint">
              A free-text note shown to reviewers via an ⓘ button on the annotation panel — what the
              fields mean as a whole, how to use them, anything worth reading before annotating. Opens
              automatically the first time a reviewer loads this project.
            </p>
            <textarea
              className="protocol-textarea"
              rows={4}
              value={schemaInfo ?? ''}
              placeholder="E.g. how to interpret ambiguous cases, or a link to the coding guide"
              onChange={(e) => setSchemaInfo(e.target.value.trim() === '' ? null : e.target.value)}
            />
          </details>
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

/** Read-only line describing where an imported project's papers came from —
 *  the recorded `provenance`, previously written to the file but shown
 *  nowhere. Not editable: it is a durable record of a past event, not a
 *  setting, so the reviewer sees it but cannot rewrite history from here. */
function ProvenanceNote({ provenance }: { provenance: ProjectProvenance }) {
  const when = formatImportedAt(provenance.importedAt)
  const from = provenance.source.title
    ? `${provenance.source.title} (${provenance.source.file})`
    : provenance.source.file
  const { included, undecided, excluded, carried } = provenance.counts
  return (
    <div className="editor-provenance" role="note">
      <span className="editor-provenance-label">Imported from</span>
      <div className="editor-provenance-body">
        <div>
          <strong>{from}</strong>
          {when && <span className="editor-provenance-when"> · {when}</span>}
        </div>
        <div className="editor-provenance-counts">
          {carried} paper{carried === 1 ? '' : 's'} carried over ({included} included, {undecided}{' '}
          undecided) · {excluded} excluded in screening, left behind
        </div>
      </div>
    </div>
  )
}

/** The ISO instant as a plain local date, or '' if it cannot be parsed — a
 *  hand-edited file could hold anything, and a bad date must not throw. */
function formatImportedAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

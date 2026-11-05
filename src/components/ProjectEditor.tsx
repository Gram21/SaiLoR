// [impl->req~edt-10~1]
// [impl->req~llm-470~1]
// [impl->req~llm-650~1]
// [impl->req~edt-180~1]
// [impl->req~edt-200~1]
// [impl->req~edt-300~1]
import { useEffect, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { useEditorStore } from '../state/editorStore'
import { annotationsDirProblem, DEFAULT_ANNOTATIONS_DIR } from '../model/annotationsDir'
import { pdfFolderProblem } from '../model/pdfFolder'
import { getPlatform } from '../platform'
import { getLanguage, rich, tp, useT, type MessageKey } from '../i18n'
import { SchemaTreeEditor } from './SchemaTreeEditor'
import { ScreeningReasonsEditor } from './ScreeningReasonsEditor'
import { ProtocolEditor } from './ProtocolEditor'
import { PapersEditor } from './PapersEditor'
import { StrictModeEditor } from './StrictModeEditor'
import { PromptOverridesEditor } from './PromptOverridesEditor'
import { SchemaPreview } from './SchemaPreview'
import type { ProjectProvenance } from '../model/project'
import type { MetadataEditMode } from '../model/metadata'
import '../styles/editor.css'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = getPlatform().kind !== 'browser' && isMac ? '⌘' : 'Ctrl'

/** Issues stay a flat string list (`validateDraft` in editorStore.ts) rather
 *  than structured per-paper objects, so a "Paper N: …" line is recognized by
 *  its leading number instead — enough to jump to it without reshaping the
 *  validator just for this. */
const ISSUE_PAPER_PREFIX = /^Paper (\d+)/
/** Past this many, the list stops rendering the rest inline — at a few
 *  hundred papers `validateDraft` emits one line per paper, which otherwise
 *  pushes the whole editor off-screen (see PapersEditor.tsx / #82). */
const ISSUE_DISPLAY_LIMIT = 12

type EditorTab = 'schema' | 'papers' | 'settings' | 'preview'
const TAB_LABELS: Record<EditorTab, MessageKey> = {
  schema: 'editor.tabs.schema',
  papers: 'editor.tabs.papers',
  settings: 'editor.tabs.settings',
  preview: 'editor.tabs.preview',
}

/**
 * Full-screen editor for a project JSON: pick where it lives, build the
 * annotation schema, and attach the PDFs to annotate. Shown instead of the
 * annotation workspace while `open` is true.
 *
 * The "Allow AI-assisted annotation" toggle below binds `EditorState.aiEnabled`,
 * which defaults to `false` for a new project (see the initial state /
 * `startNew` in editorStore.ts) — on is an explicit opt-in.
 * For a screening draft it reads "Allow AI-assisted screening".
 */
export function ProjectEditor() {
  const t = useT()
  const open = useEditorStore((s) => s.open)
  const mode = useEditorStore((s) => s.mode)
  const location = useEditorStore((s) => s.location)
  const title = useEditorStore((s) => s.title)
  const setTitle = useEditorStore((s) => s.setTitle)
  const reviewers = useEditorStore((s) => s.reviewers)
  const setReviewers = useEditorStore((s) => s.setReviewers)
  const finishCheckbox = useEditorStore((s) => s.finishCheckbox)
  const setFinishCheckbox = useEditorStore((s) => s.setFinishCheckbox)
  const aiEnabled = useEditorStore((s) => s.aiEnabled)
  const setAiEnabled = useEditorStore((s) => s.setAiEnabled)
  const aiSeat = useEditorStore((s) => s.aiSeat)
  const setAiSeat = useEditorStore((s) => s.setAiSeat)
  const metadataEdit = useEditorStore((s) => s.metadataEdit)
  const setMetadataEdit = useEditorStore((s) => s.setMetadataEdit)
  const pdfFolder = useEditorStore((s) => s.pdfFolder)
  const setPdfFolder = useEditorStore((s) => s.setPdfFolder)
  const pdfFolderIssue = pdfFolder.trim() ? pdfFolderProblem(pdfFolder.trim()) : null
  const crossrefLookup = useEditorStore((s) => s.crossrefLookup)
  const setCrossrefLookup = useEditorStore((s) => s.setCrossrefLookup)
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
  const annotationsDir = useEditorStore((s) => s.annotationsDir)
  const setAnnotationsDir = useEditorStore((s) => s.setAnnotationsDir)
  const annotationsDirIssue = annotationsDir.trim() ? annotationsDirProblem(annotationsDir.trim()) : null
  const save = useEditorStore((s) => s.save)
  const saveAndAnnotate = useEditorStore((s) => s.saveAndAnnotate)
  const close = useEditorStore((s) => s.close)
  const clearError = useEditorStore((s) => s.clearError)
  const clearNotice = useEditorStore((s) => s.clearNotice)
  const [tab, setTab] = useState<EditorTab>('schema')
  useEffect(() => {
    if (!open) setTab('schema')
  }, [open])

  if (!open) return null

  const tabs: EditorTab[] = screening ? ['schema', 'papers', 'settings'] : ['schema', 'papers', 'settings', 'preview']
  const activeTab = tab === 'preview' && screening ? 'schema' : tab
  const tabPanel = (id: EditorTab) => ({
    role: 'tabpanel',
    id: `editor-panel-${id}`,
    'aria-labelledby': `editor-tab-${id}`,
    hidden: activeTab !== id,
  })
  const onTabKey = (e: KeyboardEvent) => {
    const rtl = document.documentElement.dir === 'rtl'
    const i = tabs.indexOf(activeTab)
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key]
    const next =
      e.key === 'Home'
        ? tabs[0]
        : e.key === 'End'
          ? tabs[tabs.length - 1]
          : step
            ? tabs[(i + step + tabs.length) % tabs.length]
            : null
    if (!next) return
    e.preventDefault()
    setTab(next)
    document.getElementById(`editor-tab-${next}`)?.focus()
  }

  const onClose = () => {
    if (dirty && !window.confirm(t('editor.project.discardConfirm'))) return
    close()
  }

  // "Paper N: …" issues carry which row they're about; scroll to and focus
  // it in the (never-modal) Papers tab, switched to first.
  const jumpToPaper = (index: number) => {
    flushSync(() => setTab('papers'))
    const row = document.getElementById(`papers-row-${index}`)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    row.querySelector<HTMLInputElement>('input')?.focus()
  }

  // The full path is the useful bit on the desktop; in the browser only a name exists.
  const locationLabel = location ? (location.path ?? location.name) : t('editor.project.notSet')
  const multiReviewer = reviewers > 1
  const mod = MOD === 'Ctrl' ? t('editor.project.ctrl') : MOD

  return (
    <div className="editor">
      <div className="editor-head">
        <div className="editor-title">
          <strong>{mode === 'new' ? t('editor.project.newTitle') : t('editor.project.editTitle')}</strong>
          {dirty && (
            <span className="editor-dirty" title={t('editor.project.dirtyTitle')}>
              ●
            </span>
          )}
        </div>
        <div className="editor-actions">
          <button type="button" onClick={onClose} disabled={busy} title={t('editor.project.cancelTitle')}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={() => void save()} disabled={busy} title={t('editor.project.saveTitle', { mod })}>
            {busy ? t('editor.project.saving') : t('editor.project.saveJson')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void saveAndAnnotate()}
            disabled={busy}
            title={t('editor.project.saveAndAnnotateTitle')}
          >
            {t('editor.project.saveAndAnnotate')}
          </button>
        </div>
      </div>

      <div className="editor-location">
        <span className="editor-location-label">{t('editor.project.jsonFile')}</span>
        <code className="editor-location-path" title={locationLabel}>
          {locationLabel}
        </code>
        <button type="button" onClick={() => void changeLocation()} disabled={busy} title={t('editor.project.changeLocationTitle')}>
          {t('editor.project.change')}
        </button>
      </div>

      {error && (
        <div className="editor-error" role="alert">
          <div className="editor-error-head">
            <strong>{error.message}</strong>
            <button
              type="button"
              className="icon-btn"
              onClick={clearError}
              aria-label={t('editor.project.dismiss')}
              title={t('editor.project.dismissErrorTitle')}
            >
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
          <strong>{t('editor.project.fixBeforeSaving')}</strong>
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
                      title={t('editor.project.issueJumpTitle')}
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
            <p className="editor-issues-more">
              {t('editor.project.issuesMore', { count: issues.length - ISSUE_DISPLAY_LIMIT })}
            </p>
          )}
        </div>
      )}

      <div className="editor-tabs" role="tablist" aria-label={t('editor.tabs.label')} onKeyDown={onTabKey}>
        {tabs.map((id) => (
          <button
            key={id}
            id={`editor-tab-${id}`}
            type="button"
            role="tab"
            className="editor-tab"
            aria-selected={activeTab === id}
            aria-controls={`editor-panel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABELS[id])}
          </button>
        ))}
      </div>

      <div {...tabPanel('schema')} className="editor-body">
        <section className="editor-section">
          {/* Same "open when already recorded" rule as the protocol section
              above, for the same reason. */}
          <details className="editor-protocol-details" open={schemaInfo !== null}>
            <summary>
              <h2>{t('editor.project.schemaInfoTitle')}</h2>
              <span className="editor-protocol-summary-hint">
                {schemaInfo ? t('editor.project.recorded') : t('editor.project.optional')}
              </span>
            </summary>
            <p className="editor-hint">{rich('editor.project.schemaInfoHint')}</p>
            <textarea
              className="protocol-textarea"
              rows={4}
              value={schemaInfo ?? ''}
              placeholder={t('editor.project.schemaInfoPlaceholder')}
              onChange={(e) => setSchemaInfo(e.target.value.trim() === '' ? null : e.target.value)}
            />
          </details>
        </section>

        {screening ? (
          <section className="editor-section">
            <h2>{t('editor.project.exclusionReasonsTitle')}</h2>
            <p className="editor-hint">{t('editor.project.exclusionReasonsHint')}</p>
            <ScreeningReasonsEditor />
          </section>
        ) : (
          <section className="editor-section">
            <h2>{t('editor.project.schemaTitle')}</h2>
            <p className="editor-hint">{rich('editor.project.schemaHint')}</p>
            <SchemaTreeEditor />
          </section>
        )}
      </div>

      <div {...tabPanel('papers')} className="editor-body">
        <section className="editor-section">
          <h2>{t('editor.project.papersTitle')}</h2>
          <p className="editor-hint">{t('editor.project.papersHint')}</p>
          {notice && (
            <div className="editor-notice">
              <span>{notice}</span>
              <button
                type="button"
                className="icon-btn"
                onClick={clearNotice}
                aria-label={t('editor.project.dismiss')}
                title={t('editor.project.dismissNoticeTitle')}
              >
                ×
              </button>
            </div>
          )}
          {extracting > 0 && (
            <p className="editor-hint" role="status">
              {tp('editor.project.readingPdfs', extracting)}
            </p>
          )}
          <PapersEditor />
        </section>
      </div>

      <div {...tabPanel('settings')} className="editor-tabpanel">
        <div className="editor-location">
          <span className="editor-location-label">{t('editor.project.annotationsFolder')}</span>
          <input
            className="editor-title-input"
            type="text"
            value={annotationsDir}
            onChange={(e) => setAnnotationsDir(e.target.value)}
            placeholder={t('editor.project.annotationsDirPlaceholder', { dir: DEFAULT_ANNOTATIONS_DIR })}
            title={t('editor.project.annotationsDirTitle')}
            disabled={busy}
            aria-invalid={annotationsDirIssue !== null}
          />
        </div>
        {annotationsDirIssue && <p className="editor-field-problem">{annotationsDirIssue}</p>}

        {provenance && <ProvenanceNote provenance={provenance} />}

        <div className="editor-location">
          <span className="editor-location-label">{t('editor.project.projectTitle')}</span>
          <input
            className="editor-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('editor.project.titlePlaceholder', {
              name: location?.name ?? t('editor.project.fileNameFallback'),
            })}
            disabled={busy}
          />
        </div>

        <div className="editor-location">
          <span className="editor-location-label">{t('editor.project.screening')}</span>
          <label className="editor-ai-toggle" title={t('editor.project.screeningTitle')}>
            <input
              type="checkbox"
              checked={screening !== null}
              onChange={(e) => setScreening(e.target.checked)}
              disabled={busy}
            />
            <span>{t('editor.project.screeningToggle')}</span>
          </label>
        </div>
        {screening && <p className="editor-hint editor-screening-hint">{rich('editor.project.screeningHint')}</p>}

        <div className="editor-location">
          <span className="editor-location-label">{t('editor.project.reviewers')}</span>
          <label className="editor-ai-toggle" title={t('editor.project.reviewersTitle')}>
            <input
              type="checkbox"
              checked={multiReviewer}
              onChange={(e) => setReviewers(e.target.checked ? 2 : 1)}
              disabled={busy}
            />
            <span>{t('editor.project.multiReviewers')}</span>
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
          <p className="editor-hint editor-reviewers-hint">{rich('editor.project.reviewersHint', { reviewers })}</p>
        )}

        <div className="editor-location">
          <span className="editor-location-label">{t('editor.project.aiLabel')}</span>
          <label
            className="editor-ai-toggle"
            title={screening ? t('editor.project.aiTitleScreening') : t('editor.project.aiTitleAnnotation')}
          >
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={(e) => setAiEnabled(e.target.checked)}
              disabled={busy}
            />
            <span>{screening ? t('editor.project.allowAiScreening') : t('editor.project.allowAiAnnotation')}</span>
          </label>
        </div>
        {/* Only meaningful with AI use allowed and at least one other, human,
            reviewer to compare it against — disabled-with-a-reason otherwise
            rather than hidden, so turning either on reveals a control that
            already exists rather than a surprise new one. */}
        <div className="editor-location">
          <span className="editor-location-label">{t('editor.project.aiSeatLabel')}</span>
          <label
            className="editor-ai-toggle"
            title={
              !aiEnabled
                ? t('editor.project.aiSeatNeedsAi')
                : !multiReviewer
                  ? t('editor.project.aiSeatNeedsReviewers')
                  : t('editor.project.aiSeatTitle', { n: reviewers })
            }
          >
            <input
              type="checkbox"
              checked={aiSeat}
              onChange={(e) => setAiSeat(e.target.checked)}
              disabled={busy || !aiEnabled || !multiReviewer}
            />
            <span>{t('editor.project.aiSeatToggle', { n: reviewers })}</span>
          </label>
          {aiSeat && aiEnabled && multiReviewer && (
            <p className="editor-hint editor-reviewers-hint">{t('editor.project.aiSeatHint', { n: reviewers })}</p>
          )}
        </div>

        {/* Hidden for a screening draft: one include/exclude decision already
            settles a paper there, so the annotation panel shows no checkbox and
            the setting would configure nothing. */}
        {!screening && (
          <>
            <div className="editor-location">
              <span className="editor-location-label">{t('editor.project.finishing')}</span>
              <label className="editor-ai-toggle" title={t('editor.project.finishingTitle')}>
                <input
                  type="checkbox"
                  checked={finishCheckbox}
                  onChange={(e) => setFinishCheckbox(e.target.checked)}
                  disabled={busy}
                />
                <span>{t('editor.project.finishingToggle')}</span>
              </label>
            </div>
            <p className="editor-hint editor-reviewers-hint">
              {finishCheckbox ? (
                <>
                  {rich('editor.project.finishedHintOn')}
                  {multiReviewer && (
                    <>
                      {' '}
                      {rich('editor.project.finishedHintOnMulti')}
                    </>
                  )}
                </>
              ) : (
                rich('editor.project.finishedHintOff')
              )}
            </p>
          </>
        )}

        <div className="editor-location">
          <label className="editor-location-label" htmlFor="editor-metadata-edit">
            {t('editor.project.metadataEdit')}
          </label>
          <select
            id="editor-metadata-edit"
            value={metadataEdit}
            title={t('editor.project.metadataEditTitle')}
            onChange={(e) => setMetadataEdit(e.target.value as MetadataEditMode)}
            disabled={busy}
          >
            <option value="off">{t('editor.project.metadataEditOff')}</option>
            <option value="annotation">{t('editor.project.metadataEditAnnotation')}</option>
          </select>
        </div>

        <div className="editor-location">
          <label className="editor-location-label" htmlFor="editor-pdf-folder">
            {t('editor.project.pdfFolder')}
          </label>
          <input
            id="editor-pdf-folder"
            className="editor-title-input"
            type="text"
            value={pdfFolder}
            onChange={(e) => setPdfFolder(e.target.value)}
            placeholder={t('editor.project.pdfFolderPlaceholder')}
            title={t('editor.project.pdfFolderTitle')}
            disabled={busy}
            aria-invalid={pdfFolderIssue !== null}
          />
          <label className="editor-ai-toggle" title={t('editor.project.crossrefLookupTitle')}>
            <input
              type="checkbox"
              checked={crossrefLookup}
              onChange={(e) => setCrossrefLookup(e.target.checked)}
              disabled={busy}
            />
            <span>{t('editor.project.crossrefLookup')}</span>
          </label>
        </div>
        {pdfFolderIssue && <p className="editor-field-problem">{pdfFolderIssue}</p>}

        <div className="editor-body">
          <section className="editor-section">
            {/* Collapsed by default: optional, and most projects that use it set
                it once at the start and rarely reopen it — but open on its own
                when the project already has a protocol, so an existing one is
                never hidden behind a closed disclosure the reviewer must know to
                expand. */}
            <details className="editor-protocol-details" open={protocol !== null}>
              <summary>
                <h2>{t('editor.project.protocolTitle')}</h2>
                <span className="editor-protocol-summary-hint">
                  {protocol ? t('editor.project.recorded') : t('editor.project.optional')}
                </span>
              </summary>
              <p className="editor-hint">{t('editor.project.protocolHint')}</p>
              <ProtocolEditor />
            </details>
          </section>

          {!screening && aiEnabled && <PromptOverridesEditor />}

          {multiReviewer && !screening && <StrictModeEditor />}
        </div>
      </div>

      {activeTab === 'preview' && (
        <div {...tabPanel('preview')} className="editor-body">
          <SchemaPreview />
        </div>
      )}
    </div>
  )
}

/** Read-only line describing where an imported project's papers came from —
 *  the recorded `provenance`, previously written to the file but shown
 *  nowhere. Not editable: it is a durable record of a past event, not a
 *  setting, so the reviewer sees it but cannot rewrite history from here. */
function ProvenanceNote({ provenance }: { provenance: ProjectProvenance }) {
  const t = useT()
  const when = formatImportedAt(provenance.importedAt)
  const from = provenance.source.title
    ? `${provenance.source.title} (${provenance.source.file})`
    : provenance.source.file
  const { included, undecided, excluded, carried } = provenance.counts
  return (
    <div className="editor-provenance" role="note">
      <span className="editor-provenance-label">{t('editor.project.importedFrom')}</span>
      <div className="editor-provenance-body">
        <div>
          <strong>{from}</strong>
          {when && <span className="editor-provenance-when"> · {when}</span>}
        </div>
        <div className="editor-provenance-counts">
          {tp('editor.project.provenanceCounts', carried, { included, undecided, excluded })}
        </div>
      </div>
    </div>
  )
}

/** The ISO instant as a plain local date, or '' if it cannot be parsed — a
 *  hand-edited file could hold anything, and a bad date must not throw. */
function formatImportedAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(getLanguage())
}

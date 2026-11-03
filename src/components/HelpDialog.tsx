// [impl->req~ui-100~1]
import { useEffect, useRef, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { getPlatform } from '../platform'
import { NEW_ISSUE_URL } from '../model/version'
import { getLanguage, rich, t, useT, type MessageKey } from '../i18n'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MAC_APP = getPlatform().kind !== 'browser' && isMac
// [impl->req~ui-10~1]
function mod(): string {
  if (MAC_APP) return '⌘'
  return getLanguage() === 'de' ? 'Strg' : 'Ctrl'
}
function shift(): string {
  return getLanguage() === 'de' ? 'Umschalt' : 'Shift'
}

type ShortcutRows = Array<[string, MessageKey]>

/** Shortcuts while annotating a project. */
function annotateKeys(): ShortcutRows {
  const m = mod()
  const s = shift()
  return [
    [`${m}+O`, 'help.keys.openProject'],
    [`${m}+S`, 'common.save'],
    [`${m}+${s}+S`, 'help.keys.saveAs'],
    [`${m}+Z`, 'help.keys.undoAnnotation'],
    [`${m}+${s}+Z`, 'help.keys.redoAnnotation'],
    [`${m}+F`, 'help.keys.searchPdf'],
    [`${m} + / ${m} -`, 'help.keys.zoomPdf'],
    [`${m}+0`, 'help.keys.resetPdfZoom'],
    ['Alt+↓  /  ]', 'help.keys.nextPaper'],
    ['Alt+↑  /  [', 'help.keys.previousPaper'],
    [`${m}+${s} + / -`, 'help.keys.appFontSize'],
    [`${m}+${s}+0`, 'help.keys.resetAppFontSize'],
    [`${m}+C / V / X`, 'help.keys.copyPaste'],
    [`${m}+,`, 'help.keys.openSettings'],
    ['F1', 'help.keys.openHelp'],
  ]
}

/** Shortcuts on the start screen, before anything is open. */
function startKeys(): ShortcutRows {
  const m = mod()
  const s = shift()
  return [
    [`${m}+O`, 'help.keys.openProject'],
    [`${m}+${s} + / -`, 'help.keys.appFontSize'],
    [`${m}+${s}+0`, 'help.keys.resetAppFontSize'],
    [`${m}+,`, 'help.keys.openSettings'],
    ['F1', 'help.keys.openHelp'],
  ]
}

/** Shortcuts while screening a project (replaces the annotation shortcuts). */
function screeningKeys(): ShortcutRows {
  const m = mod()
  return [
    [`${m}+O`, 'help.keys.openProject'],
    [`${m}+S`, 'common.save'],
    [`${m}+Z`, 'help.keys.screenUndo'],
    ['I', 'help.keys.screenInclude'],
    ['E', 'help.keys.screenExclude'],
    ['U', 'help.keys.screenUndecide'],
    ['1 – 9', 'help.keys.screenReason'],
    ['Alt+↓  /  ]', 'help.keys.nextPaper'],
    ['Alt+↑  /  [', 'help.keys.previousPaper'],
    [`${m}+,`, 'help.keys.openSettings'],
    ['F1', 'help.keys.openHelp'],
  ]
}

/** Shortcuts while building or editing the annotation JSON. */
function editorKeys(): ShortcutRows {
  const m = mod()
  const s = shift()
  return [
    [`${m}+S`, 'help.keys.editorSave'],
    [`${m}+${s}+S`, 'help.keys.editorSaveAs'],
    [`${m}+Z`, 'help.keys.editorUndo'],
    [`${m}+${s}+Z`, 'help.keys.redo'],
    [`${m}+${s} + / -`, 'help.keys.appFontSize'],
    [`${m}+${s}+0`, 'help.keys.resetAppFontSize'],
    [`${m}+C / V / X`, 'help.keys.copyPaste'],
    [`${m}+,`, 'help.keys.openSettings'],
    ['F1', 'help.keys.openHelp'],
  ]
}

function ShortcutTable({ keys }: { keys: ShortcutRows }) {
  const t = useT()
  return (
    <table className="help-keys">
      <tbody>
        {keys.map(([combo, desc]) => (
          <tr key={combo}>
            <td>
              <kbd>{combo}</kbd>
            </td>
            <td>{t(desc)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * One entry in the help. The table of contents is generated from these rather
 * than hand-written beside them, so a section can never be added, renamed or
 * dropped without the contents following it.
 */
interface HelpSection {
  id: string
  title: string
  body: ReactNode
}

/** One question/answer pair. Rendered as a `<details>` so the FAQ stays skimmable. */
function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="help-faq">
      <summary>{q}</summary>
      <div className="help-faq-body">{children}</div>
    </details>
  )
}

/** Answers that hold on every screen, so all three modes list them. */
function commonFaqs(): ReactNode {
  return (
    <>
      <Faq q={t('help.common.faq.data.q')}>
        <p>{rich('help.common.faq.data.a')}</p>
      </Faq>
      <Faq q={t('help.common.faq.concurrent.q')}>
        <p>{rich('help.common.faq.concurrent.a', { reviewers: t('help.annotate.reviewers.title') })}</p>
      </Faq>
      <Faq q={t('help.common.faq.moved.q')}>
        <p>{rich('help.common.faq.moved.a')}</p>
      </Faq>
      <Faq q={t('help.common.faq.consolidation.q')}>
        <p>{rich('help.common.faq.consolidation.a1')}</p>
        <p>{rich('help.common.faq.consolidation.a2')}</p>
      </Faq>
      <Faq q={t('help.common.faq.autosave.q')}>
        <p>{rich('help.common.faq.autosave.a', { mod: mod() })}</p>
      </Faq>
    </>
  )
}

/** Help for the start screen — nothing is open yet, so describe the tool itself. */
function startHelp(): { lead: ReactNode; sections: HelpSection[] } {
  return {
    lead: (
      <>
        <p>{rich('help.start.lead.1')}</p>
        <p>{rich('help.start.lead.2')}</p>
      </>
    ),
    sections: [
      {
        id: 'options',
        title: t('help.start.options.title'),
        body: (
          <ul>
            <li>{rich('help.start.options.open')}</li>
            <li>{rich('help.start.options.new')}</li>
            <li>{rich('help.start.options.edit')}</li>
          </ul>
        ),
      },
      {
        id: 'which',
        title: t('help.start.which.title'),
        body: <p>{rich('help.start.which.text')}</p>,
      },
      {
        id: 'faq',
        title: t('help.common.faqTitle'),
        body: (
          <>
            <Faq q={t('help.start.faq.project.q')}>
              <p>{rich('help.start.faq.project.a')}</p>
            </Faq>
            <Faq q={t('help.start.faq.handJson.q')}>
              <p>{rich('help.start.faq.handJson.a')}</p>
            </Faq>
            {commonFaqs()}
          </>
        ),
      },
      {
        id: 'shortcuts',
        title: t('help.common.shortcutsTitle'),
        body: <ShortcutTable keys={startKeys()} />,
      },
    ],
  }
}

/** Help for the annotation view. */
function annotateHelp(): { lead: ReactNode; sections: HelpSection[] } {
  return {
    lead: <p>{rich('help.annotate.lead')}</p>,
    sections: [
      {
        id: 'workflow',
        title: t('help.annotate.workflow.title'),
        body: (
          <ul>
            <li>{rich('help.annotate.workflow.open')}</li>
            <li>{rich('help.annotate.workflow.pick')}</li>
            <li>{rich('help.annotate.workflow.read', { mod: mod() })}</li>
            <li>{rich('help.annotate.workflow.annotate')}</li>
            <li>{rich('help.annotate.workflow.info')}</li>
            <li>{rich('help.annotate.workflow.validate')}</li>
            <li>{rich('help.annotate.workflow.save', { mod: mod() })}</li>
          </ul>
        ),
      },
      {
        id: 'searching',
        title: t('help.annotate.searching.title'),
        body: (
          <>
            <p>{rich('help.annotate.searching.p1')}</p>
            <p>{rich('help.annotate.searching.p2')}</p>
          </>
        ),
      },
      {
        id: 'reviewers',
        title: t('help.annotate.reviewers.title'),
        body: (
          <>
            <p>{rich('help.annotate.reviewers.p1')}</p>
            <p>{rich('help.annotate.reviewers.p2')}</p>
            <p>{rich('help.annotate.reviewers.p3')}</p>
            <p>{rich('help.annotate.reviewers.p4')}</p>
            <p>{rich('help.annotate.reviewers.p5')}</p>
            <p>{rich('help.annotate.reviewers.p6')}</p>
            <p>{rich('help.annotate.reviewers.p7')}</p>
            <p>{rich('help.annotate.reviewers.p8')}</p>
            <p>{rich('help.annotate.reviewers.p9')}</p>
            <p>{rich('help.annotate.reviewers.p10')}</p>
          </>
        ),
      },
      {
        id: 'faq',
        title: t('help.common.faqTitle'),
        body: (
          <>
            <Faq q={t('help.annotate.faq.validate.q')}>
              <p>{rich('help.annotate.faq.validate.a')}</p>
            </Faq>
            <Faq q={t('help.annotate.faq.yesNo.q')}>
              <p>{rich('help.annotate.faq.yesNo.a')}</p>
            </Faq>
            <Faq q={t('help.annotate.faq.schema.q')}>
              <p>{rich('help.annotate.faq.schema.a')}</p>
            </Faq>
            {commonFaqs()}
          </>
        ),
      },
      {
        id: 'shortcuts',
        title: t('help.common.shortcutsTitle'),
        body: <ShortcutTable keys={annotateKeys()} />,
      },
    ],
  }
}

/** Help for the screening view — a fundamentally different activity from
 *  annotation, so it gets its own mode rather than a section bolted onto
 *  `annotateHelp`. */
function screeningHelp(): { lead: ReactNode; sections: HelpSection[] } {
  return {
    lead: <p>{rich('help.screening.lead')}</p>,
    sections: [
      {
        id: 'what',
        title: t('help.screening.what.title'),
        body: <p>{rich('help.screening.what.p')}</p>,
      },
      {
        id: 'decision',
        title: t('help.screening.decision.title'),
        body: <p>{rich('help.screening.decision.p')}</p>,
      },
      {
        id: 'reasons',
        title: t('help.screening.reasons.title'),
        body: <p>{rich('help.screening.reasons.p')}</p>,
      },
      {
        id: 'keys',
        title: t('help.screening.keys.title'),
        body: <p>{rich('help.screening.keys.p')}</p>,
      },
      {
        id: 'reviewers',
        title: t('help.screening.reviewers.title'),
        body: <p>{rich('help.screening.reviewers.p')}</p>,
      },
      {
        id: 'ai',
        title: t('help.screening.ai.title'),
        body: <p>{rich('help.screening.ai.p')}</p>,
      },
      {
        id: 'summary',
        title: t('help.screening.summary.title'),
        body: <p>{rich('help.screening.summary.p')}</p>,
      },
      {
        id: 'importing',
        title: t('help.screening.importing.title'),
        body: <p>{rich('help.screening.importing.p')}</p>,
      },
      { id: 'faq', title: t('help.common.faqTitle'), body: commonFaqs() },
      { id: 'shortcuts', title: t('help.common.shortcutsTitle'), body: <ShortcutTable keys={screeningKeys()} /> },
    ],
  }
}

/** Help for the project editor (schema + papers). */
function editorHelp(): { lead: ReactNode; sections: HelpSection[] } {
  return {
    lead: <p>{rich('help.editor.lead')}</p>,
    sections: [
      {
        id: 'location',
        title: t('help.editor.location.title'),
        body: <p>{rich('help.editor.location.p')}</p>,
      },
      {
        id: 'schema',
        title: t('help.editor.schema.title'),
        body: (
          <ul>
            <li>{rich('help.editor.schema.add')}</li>
            <li>{rich('help.editor.schema.type')}</li>
            <li>{rich('help.editor.schema.repeats')}</li>
            <li>{rich('help.editor.schema.choices')}</li>
            <li>{rich('help.editor.schema.reorder')}</li>
          </ul>
        ),
      },
      {
        id: 'reviewers',
        title: t('help.editor.reviewers.title'),
        body: <p>{rich('help.editor.reviewers.p')}</p>,
      },
      {
        id: 'ai-assisted-annotation',
        title: t('help.editor.ai.title'),
        body: <p>{rich('help.editor.ai.p')}</p>,
      },
      {
        id: 'ai-seat',
        title: t('help.editor.aiSeat.title'),
        body: <p>{rich('help.editor.aiSeat.p')}</p>,
      },
      {
        id: 'papers',
        title: t('help.editor.papers.title'),
        body: (
          <>
            <p>{rich('help.editor.papers.intro')}</p>
            <ul>
              <li>{rich('help.editor.papers.addPdfs')}</li>
              <li>{rich('help.editor.papers.addFolder')}</li>
              <li>{rich('help.editor.papers.import')}</li>
            </ul>
            <p>{rich('help.editor.papers.duplicates')}</p>
            <p>{rich('help.editor.papers.guessed')}</p>
          </>
        ),
      },
      {
        id: 'saving',
        title: t('help.editor.saving.title'),
        body: <p>{rich('help.editor.saving.p')}</p>,
      },
      {
        id: 'faq',
        title: t('help.common.faqTitle'),
        body: (
          <>
            <Faq q={t('help.editor.faq.noPdf.q')}>
              <p>{rich('help.editor.faq.noPdf.a')}</p>
            </Faq>
            <Faq q={t('help.editor.faq.badTitle.q')}>
              <p>{rich('help.editor.faq.badTitle.a')}</p>
            </Faq>
            <Faq q={t('help.editor.faq.reuse.q')}>
              <p>{rich('help.editor.faq.reuse.a')}</p>
            </Faq>
            <Faq q={t('help.editor.faq.rename.q')}>
              <p>{rich('help.editor.faq.rename.a')}</p>
            </Faq>
            {commonFaqs()}
          </>
        ),
      },
      {
        id: 'shortcuts',
        title: t('help.common.shortcutsTitle'),
        body: <ShortcutTable keys={editorKeys()} />,
      },
    ],
  }
}

/** Sections every mode shares, appended after the mode-specific ones. */
function sharedSections(): HelpSection[] {
  return [
    {
      id: 'appearance',
      title: t('help.appearance.title'),
      body: <p>{rich('help.appearance.p')}</p>,
    },
    {
      id: 'license',
      title: t('help.license.title'),
      body: (
        <p>
          {rich('help.license.p', undefined, {
            link: (children) => (
              <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
          })}
        </p>
      ),
    },
  ]
}

/** Modal explaining the current mode and listing its keyboard shortcuts. */
export function HelpDialog() {
  const open = useStore((s) => s.helpOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  // The help must describe the screen the user is actually looking at: the
  // editor, an open project, or the start screen with neither.
  const editing = useEditorStore((s) => s.open)
  const hasProject = useStore((s) => s.project !== null)
  const screening = useStore((s) => s.project?.screening != null)
  const mode = editing ? 'editor' : hasProject ? (screening ? 'screening' : 'annotate') : 'start'
  const bodyRef = useRef<HTMLDivElement>(null)
  useT()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelpOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setHelpOpen])

  if (!open) return null

  const { lead, sections: modeSections } =
    mode === 'editor'
      ? editorHelp()
      : mode === 'screening'
        ? screeningHelp()
        : mode === 'annotate'
          ? annotateHelp()
          : startHelp()
  const sections = [...modeSections, ...sharedSections()]

  // Scroll the modal's own body rather than the page: an `href="#id"` would
  // navigate the SPA (and do nothing at all under file:// in the packaged app).
  // Instant, not smooth — matching the PDF pane's link jumps, and because a
  // smooth scroll inside this container was observed to silently do nothing.
  const jumpTo = (id: string) => {
    bodyRef.current?.querySelector(`#help-${id}`)?.scrollIntoView({ block: 'start' })
  }
  // Back to the contents at the top, which is the only thing worth returning
  // to — set scrollTop rather than scrolling the lead into view, so this can
  // never be a no-op when the body happens to already be near the top.
  const jumpToTop = () => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }

  return (
    <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
      <div
        className="modal help-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            {t('help.title')}{' '}
            <span className="help-mode">
              {mode === 'editor'
                ? t('help.mode.editor')
                : mode === 'screening'
                  ? t('help.mode.screening')
                  : mode === 'annotate'
                    ? t('help.mode.annotate')
                    : t('help.mode.start')}
            </span>
          </strong>
          <div className="modal-head-actions">
            <a
              className="icon-btn help-report-bug"
              href={NEW_ISSUE_URL}
              target="_blank"
              rel="noreferrer"
              title={t('help.reportBugTitle')}
            >
              {t('help.reportBug')}
            </a>
            <button
              type="button"
              className="icon-btn"
              title={t('help.closeTitle')}
              onClick={() => setHelpOpen(false)}
              aria-label={t('common.close')}
            >
              ×
            </button>
          </div>
        </div>

        <div className="modal-body" ref={bodyRef}>
          <div className="help-lead">{lead}</div>

          <nav className="help-toc" aria-label={t('help.tocLabel')}>
            <span className="help-toc-title">{t('help.tocTitle')}</span>
            <ul>
              {sections.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="help-toc-link"
                    title={t('help.tocJump', { title: s.title })}
                    onClick={() => jumpTo(s.id)}
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {sections.map((s) => (
            <section key={s.id}>
              <h3 id={`help-${s.id}`}>{s.title}</h3>
              {s.body}
              {/* Every section is a plausible place to have finished reading,
                  and the contents are only at the top. */}
              <div className="help-top-row">
                <button
                  type="button"
                  className="help-top-link"
                  title={t('help.backToTopTitle')}
                  onClick={jumpToTop}
                >
                  {t('help.backToTop')}
                </button>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

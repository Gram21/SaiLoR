import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import type { IssueKind, ValidationIssue } from '../model/validate'

const KIND_LABEL: Record<IssueKind, string> = {
  required: 'Missing',
  type: 'Wrong type',
  enum: 'Not an allowed value',
  cardinality: 'Wrong number of entries',
  screening: 'Screening',
}

function matchesQuery(title: string, query: string, caseSensitive: boolean) {
  const q = caseSensitive ? query.trim() : query.trim().toLowerCase()
  if (q === '') return true
  return (caseSensitive ? title : title.toLowerCase()).includes(q)
}

/** Plain-lined crosshair — deliberately not a colorful emoji, so it reads as
 * a UI control rather than decoration and matches the rest of the toolbar. */
function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="1" x2="12" y2="5" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" />
      <line x1="1" y1="12" x2="5" y2="12" stroke="currentColor" strokeWidth="2" />
      <line x1="19" y1="12" x2="23" y2="12" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

/** Plain chevrons, like a browser's back/forward buttons. */
function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <polyline points="15 4 7 12 15 20" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
function ForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <polyline points="9 4 17 12 9 20" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

function JumpButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="validation-jump"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <TargetIcon />
    </button>
  )
}

function PaperFilter({
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  label,
}: {
  query: string
  onQueryChange: (q: string) => void
  caseSensitive: boolean
  onCaseSensitiveChange: (c: boolean) => void
  label: string
}) {
  return (
    <div className="validation-search">
      <input
        type="text"
        className="validation-search-input"
        placeholder="Filter papers…"
        aria-label={label}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {query && (
        <button
          type="button"
          className="validation-search-clear"
          title="Clear filter"
          aria-label="Clear filter"
          onClick={() => onQueryChange('')}
        >
          ×
        </button>
      )}
      <button
        type="button"
        className={`validation-search-case${caseSensitive ? ' active' : ''}`}
        title={
          caseSensitive
            ? 'Matching exact case. Click to ignore case again.'
            : 'Ignoring case. Click to match exact case instead.'
        }
        aria-label="Toggle case-sensitive filter"
        aria-pressed={caseSensitive}
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        Aa
      </button>
    </div>
  )
}

function IssueList({ issues, onIssueClick }: { issues: ValidationIssue[]; onIssueClick: (issue: ValidationIssue) => void }) {
  return (
    <ul className="validation-issues">
      {issues.map((issue, i) => (
        <li key={i}>
          <button
            type="button"
            className="validation-issue"
            onClick={() => onIssueClick(issue)}
            title={issue.canonicalPath ? 'Jump to this field' : 'Open this paper'}
          >
            <span className={`validation-kind kind-${issue.kind}`}>{KIND_LABEL[issue.kind]}</span>
            <span className="validation-path">{issue.path}</span>
            <span className="validation-msg">{issue.message}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Results of "Validate": what still has to be fixed, split into three
 * sections. "Current paper" is always shown, since that's the one a reviewer
 * is actually looking at and the flat list this replaces made it hard to
 * find. "Other papers" and "Not started yet" default to collapsed — both
 * get their own paper-title filter, since either can span the whole project.
 *
 * A paper with no annotations at all is never validated — it would fail every
 * required field for the single reason that it hasn't been started, which
 * says nothing a reviewer doesn't already know. Those papers make up the
 * "Not started yet" section instead, as a plain checklist.
 */
export function ValidationDialog() {
  const open = useStore((s) => s.validationOpen)
  const issues = useStore((s) => s.validation)
  const unannotated = useStore((s) => s.validationUnannotated)
  const setOpen = useStore((s) => s.setValidationOpen)
  const selectPaper = useStore((s) => s.selectPaper)
  const setPendingFieldJump = useStore((s) => s.setPendingFieldJump)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const project = useStore((s) => s.project)

  // Group by paper, preserving the paper order validateProject walked in.
  const byPaper = useMemo(() => {
    const groups = new Map<string, { title: string; issues: ValidationIssue[] }>()
    for (const issue of issues ?? []) {
      const group = groups.get(issue.paperId) ?? { title: issue.paperTitle, issues: [] }
      group.issues.push(issue)
      groups.set(issue.paperId, group)
    }
    return [...groups.entries()]
  }, [issues])

  const [otherOpen, setOtherOpen] = useState(false)
  const [notStartedOpen, setNotStartedOpen] = useState(false)
  const [otherQuery, setOtherQuery] = useState('')
  const [notStartedQuery, setNotStartedQuery] = useState('')
  const [otherCaseSensitive, setOtherCaseSensitive] = useState(false)
  const [notStartedCaseSensitive, setNotStartedCaseSensitive] = useState(false)
  const [expandedPapers, setExpandedPapers] = useState<Set<string>>(new Set())
  // Browser-style history of papers jumped to from this dialog (jumping no
  // longer closes it, so a reviewer can hop between several papers and step
  // back/forward through them). `index` is the current position in `list`;
  // jumping to a new paper truncates anything ahead of it, same as a browser
  // discarding forward history after a fresh navigation.
  const [paperHistory, setPaperHistory] = useState<{ list: string[]; index: number }>({
    list: [],
    index: -1,
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // A fresh run each time the dialog opens, so a stale filter or expanded
  // paper from the previous "Validate" click doesn't linger.
  useEffect(() => {
    if (!open) return
    setOtherOpen(false)
    setNotStartedOpen(false)
    setOtherQuery('')
    setNotStartedQuery('')
    setOtherCaseSensitive(false)
    setNotStartedCaseSensitive(false)
    setExpandedPapers(new Set())
    // Seed history with whatever paper was open when "Validate" was clicked,
    // so back/forward has a starting point.
    setPaperHistory(currentPaperId ? { list: [currentPaperId], index: 0 } : { list: [], index: -1 })
    // Captured once, at the moment the dialog opens — not kept in sync with
    // `currentPaperId` afterwards, which changes as soon as a jump is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open || !issues || !unannotated) return null

  // Deliberately doesn't close the dialog: a jump is meant for hopping
  // between papers while comparing their problems, not for ending the review.
  const goToPaper = (paperId: string) => {
    selectPaper(paperId)
    if (paperHistory.list[paperHistory.index] === paperId) return
    const truncated = paperHistory.list.slice(0, paperHistory.index + 1)
    truncated.push(paperId)
    setPaperHistory({ list: truncated, index: truncated.length - 1 })
  }

  const goBack = () => {
    if (paperHistory.index <= 0) return
    const index = paperHistory.index - 1
    selectPaper(paperHistory.list[index])
    setPaperHistory({ ...paperHistory, index })
  }

  const goForward = () => {
    if (paperHistory.index >= paperHistory.list.length - 1) return
    const index = paperHistory.index + 1
    selectPaper(paperHistory.list[index])
    setPaperHistory({ ...paperHistory, index })
  }

  // Jumps to the paper AND, when the issue names one, scrolls the annotation
  // panel to that exact field and flashes it — `canonicalPath` is empty only
  // for a screening issue (no annotation-panel field to point at) or a
  // caught structural error, in which case this is the same as `goToPaper`.
  const goToIssue = (issue: ValidationIssue) => {
    selectPaper(issue.paperId)
    if (issue.canonicalPath) setPendingFieldJump(issue.canonicalPath)
    setOpen(false)
  }

  const toggleExpanded = (paperId: string) => {
    setExpandedPapers((prev) => {
      const next = new Set(prev)
      if (next.has(paperId)) next.delete(paperId)
      else next.add(paperId)
      return next
    })
  }

  const currentIssues = byPaper.find(([id]) => id === currentPaperId)?.[1]?.issues ?? []
  const otherGroups = byPaper.filter(([id]) => id !== currentPaperId)
  const otherIssueCount = otherGroups.reduce((n, [, g]) => n + g.issues.length, 0)
  const filteredOtherGroups = otherGroups.filter(([, g]) =>
    matchesQuery(g.title, otherQuery, otherCaseSensitive),
  )
  const filteredUnannotated = unannotated.filter((p) =>
    matchesQuery(p.paperTitle, notStartedQuery, notStartedCaseSensitive),
  )
  const titleOf = (paperId: string) => project?.papers.find((p) => p.id === paperId)?.title
  const canGoBack = paperHistory.index > 0
  const canGoForward = paperHistory.index < paperHistory.list.length - 1
  const backTitle = canGoBack ? titleOf(paperHistory.list[paperHistory.index - 1]) : undefined
  const forwardTitle = canGoForward ? titleOf(paperHistory.list[paperHistory.index + 1]) : undefined

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal validation-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            Validation{' '}
            <span className={issues.length === 0 ? 'help-mode ok' : 'help-mode bad'}>
              {issues.length === 0
                ? 'No problems'
                : `${issues.length} problem${issues.length === 1 ? '' : 's'}`}
            </span>
          </strong>
          <div className="modal-head-actions">
            <button
              type="button"
              className={`icon-btn validation-nav${canGoBack ? '' : ' disabled'}`}
              // A native `disabled` button fires no mouseover in most browsers, so its
              // `title` tooltip never shows — `aria-disabled` keeps the button hoverable
              // (the click is still a no-op via `goBack`'s own guard) so the "why" is
              // visible right when a reviewer wonders why nothing happens.
              aria-disabled={!canGoBack}
              title={backTitle ? `Back to the previous paper: "${backTitle}"` : 'No earlier paper to go back to'}
              aria-label={backTitle ? `Back to the previous paper: ${backTitle}` : 'No earlier paper to go back to'}
              onClick={goBack}
            >
              <BackIcon />
            </button>
            <button
              type="button"
              className={`icon-btn validation-nav${canGoForward ? '' : ' disabled'}`}
              aria-disabled={!canGoForward}
              title={forwardTitle ? `Forward to the next paper: "${forwardTitle}"` : 'No later paper to go forward to'}
              aria-label={
                forwardTitle ? `Forward to the next paper: ${forwardTitle}` : 'No later paper to go forward to'
              }
              onClick={goForward}
            >
              <ForwardIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setOpen(false)}
              aria-label="Close"
              title="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div className="modal-body">
          <p className="validation-intro">
            Click a problem to jump to it. Note that <em>Yes/no</em> fields always count as
            answered — an unticked box means <em>no</em>.
          </p>

          <section className="validation-group validation-current">
            <h3 className="validation-section-title-plain">Current paper</h3>
            {!currentPaperId ? (
              <p className="validation-empty">No paper is open.</p>
            ) : currentIssues.length === 0 ? (
              <p className="validation-empty">No problems.</p>
            ) : (
              <IssueList issues={currentIssues} onIssueClick={goToIssue} />
            )}
          </section>

          <section className="validation-group validation-section">
            <button
              type="button"
              className="validation-section-header"
              title={otherOpen ? 'Collapse' : 'Expand'}
              onClick={() => setOtherOpen((o) => !o)}
              aria-expanded={otherOpen}
            >
              <span className="validation-caret">{otherOpen ? '▾' : '▸'}</span>
              Other papers
              <span className="count">
                {otherIssueCount} problem{otherIssueCount === 1 ? '' : 's'}
              </span>
            </button>
            {otherOpen && (
              <div className="validation-section-body">
                <PaperFilter
                  query={otherQuery}
                  onQueryChange={setOtherQuery}
                  caseSensitive={otherCaseSensitive}
                  onCaseSensitiveChange={setOtherCaseSensitive}
                  label="Filter other papers"
                />
                {filteredOtherGroups.length === 0 ? (
                  <p className="validation-empty">No matching papers.</p>
                ) : (
                  filteredOtherGroups.map(([paperId, group]) => (
                    <div key={paperId} className="validation-group">
                      <div
                        className="validation-paper clickable"
                        role="button"
                        tabIndex={0}
                        title={expandedPapers.has(paperId) ? 'Collapse' : 'Expand to see problems'}
                        onClick={() => toggleExpanded(paperId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleExpanded(paperId)
                          }
                        }}
                        aria-expanded={expandedPapers.has(paperId)}
                      >
                        <span className="validation-caret">
                          {expandedPapers.has(paperId) ? '▾' : '▸'}
                        </span>
                        <span className="validation-paper-title">{group.title}</span>
                        <span className="count">
                          {group.issues.length} problem{group.issues.length === 1 ? '' : 's'}
                        </span>
                        <JumpButton title={`Jump to this paper: ${group.title}`} onClick={() => goToPaper(paperId)} />
                      </div>
                      {expandedPapers.has(paperId) && (
                        <IssueList issues={group.issues} onIssueClick={goToIssue} />
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </section>

          <section className="validation-group validation-section validation-unannotated">
            <button
              type="button"
              className="validation-section-header"
              title={notStartedOpen ? 'Collapse' : 'Expand'}
              onClick={() => setNotStartedOpen((o) => !o)}
              aria-expanded={notStartedOpen}
            >
              <span className="validation-caret">{notStartedOpen ? '▾' : '▸'}</span>
              Not started yet
              <span className="count">
                {unannotated.length} paper{unannotated.length === 1 ? '' : 's'}
              </span>
            </button>
            {notStartedOpen && (
              <div className="validation-section-body">
                <PaperFilter
                  query={notStartedQuery}
                  onQueryChange={setNotStartedQuery}
                  caseSensitive={notStartedCaseSensitive}
                  onCaseSensitiveChange={setNotStartedCaseSensitive}
                  label="Filter not-started papers"
                />
                {filteredUnannotated.length === 0 ? (
                  <p className="validation-empty">No matching papers.</p>
                ) : (
                  <ul className="validation-unannotated-list">
                    {filteredUnannotated.map((p) => (
                      <li key={p.paperId}>
                        <div className="validation-paper">
                          <span className="validation-paper-title">{p.paperTitle}</span>
                          <JumpButton title={`Jump to this paper: ${p.paperTitle}`} onClick={() => goToPaper(p.paperId)} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

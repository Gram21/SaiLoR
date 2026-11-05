// [impl->req~con-460~1]
// [impl->req~lst-80~1]
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useStore, currentTree, currentFinished, activePerson } from '../state/store'
import { assignedSeat, personPapers } from '../model/strict'
import { editedFields, effectiveMetadata, metadataSeatKey } from '../model/metadata'
import { hasAnnotations, annotationText } from '../model/annotations'
import { completeness, completenessPercent, hasRequiredFields, type Completeness } from '../model/completeness'
import {
  annotationState,
  annotationStateFor,
  completenessApplies,
  matchesFilter,
  annotationFiltersFor,
  type AnnotationFilter,
  type AnnotationState,
} from '../model/annotationState'
import { readyToConsolidate } from '../consolidate/readiness'
import { screeningStatus, type ScreeningStatus } from '../screening/status'
import { SidebarToggle } from './SidebarToggle'
import type { Paper, Project } from '../model/project'
import { t, useLanguage, useT, type MessageKey } from '../i18n'

/** Which text a query word is matched against. */
type SearchMode = 'metadata' | 'annotations'

const FILTER_KEY: Record<AnnotationFilter, MessageKey> = {
  all: 'paperList.filter.all',
  open: 'paperList.filter.open',
  'in-progress': 'paperList.filter.inProgress',
  finished: 'paperList.filter.finished',
  issues: 'paperList.filter.issues',
}

const PROGRESS_KEY: Record<Exclude<AnnotationFilter, 'all'>, MessageKey> = {
  open: 'paperList.progress.open',
  'in-progress': 'paperList.progress.inProgress',
  finished: 'paperList.progress.finished',
  issues: 'paperList.progress.issues',
}

const SCREENING_LABEL_KEY: Record<'all' | 'undecided' | 'included' | 'excluded', MessageKey> = {
  all: 'paperList.screening.all',
  undecided: 'paperList.screening.undecided',
  included: 'paperList.screening.included',
  excluded: 'paperList.screening.excluded',
}

const SCREENING_SHOW_KEY: Record<'all' | 'undecided' | 'included' | 'excluded', MessageKey> = {
  all: 'paperList.screening.showAll',
  undecided: 'paperList.screening.showUndecided',
  included: 'paperList.screening.showIncluded',
  excluded: 'paperList.screening.showExcluded',
}

// [impl->req~lst-30~1]
/**
 * The sentence each state's dot leads its tooltip/`aria-label` with. This is
 * the only place the color's meaning is stated, and the sole route to it for
 * a screen reader; `finishBox` is the seat's sign-off checkbox label, named
 * outright in the `complete` case.
 */
function dotStateLabel(state: AnnotationState, finishBox: string): string {
  switch (state) {
    case 'untouched':
      return t('paperList.dot.untouched')
    case 'partial':
      return t('paperList.dot.partial')
    case 'complete':
      return t('paperList.dot.complete', { finishBox })
    case 'finished':
      return t('paperList.dot.finished')
    case 'flagged':
      return t('paperList.dot.flagged')
  }
}

/** A paper paired with a precomputed, lowercased searchable string per mode. */
interface IndexedPaper {
  paper: Paper
  metadataHaystack: string
  annotationHaystack: string
  /** `null` when the fill does not apply to this seat — see `completenessApplies`. */
  completeness: Completeness | null
  /** `null` in the same seats `completeness` is null for. */
  state: AnnotationState | null
  /** Whether this seat recorded at least one annotation entry — independent of
   *  `state`: a paper touched only via a Yes/No answer is `touched` but stays
   *  `untouched` (completeness ignores booleans). */
  touched: boolean
}

/**
 * The completeness numbers behind a paper's dot fill, or `null` where it does
 * not apply — see `completenessApplies`. Exported standalone so it is
 * unit-testable without rendering the list.
 */
export function paperCompleteness(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): Completeness | null {
  if (!completenessApplies(project)) return null
  return completeness(project.schema, currentTree(project, currentReviewer, paper))
}

// [impl->req~lst-30~1]
/**
 * A paper's annotation state for the active seat — the dot's color, what the
 * filter dropdown matches, and what the counter counts. `null` where
 * completeness does not apply (a screening project).
 *
 * Always derived, never stored: only the reviewer's tick is persisted, so
 * emptying a field on a finished paper re-evaluates the mark by itself
 * (becomes `flagged`), and refilling it restores `finished`.
 */
export function paperAnnotationState(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): AnnotationState | null {
  return annotationStateFor(
    project.schema,
    currentTree(project, currentReviewer, paper),
    currentFinished(project, currentReviewer, paper) === true,
    completenessApplies(project),
    project.finishCheckbox,
  )
}

/** Shorthand for "green in the list": declared finished *and* still complete
 *  — a sign-off does not survive the data it was about going away. */
export function paperIsFinished(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): boolean {
  return paperAnnotationState(project, paper, currentReviewer) === 'finished'
}

/**
 * Whether a paper reads as "done" for a seat:
 *  - single/numbered reviewer or multi-reviewer-nobody-picked: `hasAnnotations`
 *    over the seat's own tree.
 *  - Consolidation: `readyToConsolidate` (every reviewer has recorded
 *    something), not "has the consolidated tree got content" — that tree gets
 *    auto-filled by `adoptUnanimousValues` just from opening the paper, so it
 *    can't answer readiness. Same rule `Field.tsx` uses to gate the compare
 *    popup, so list and popup can't disagree on which papers are ready.
 */
export function paperIsMarkedDone(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): boolean {
  if (project.reviewers > 1 && currentReviewer === 'consolidation') {
    return readyToConsolidate(project.schema, paper, project.reviewers)
  }
  const tree = currentTree(project, currentReviewer, paper)
  return !!tree && hasAnnotations(project.schema, tree)
}

/**
 * The screening marker's state for a paper: a numbered reviewer's own
 * decision, or Consolidation's shipped result. Deliberately not
 * `paperIsMarkedDone`'s readiness meaning here — with one decision per paper,
 * "the final decision so far" is more useful; readiness still shows up in the
 * marker's tooltip below.
 */
export function paperScreeningStatus(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): ScreeningStatus {
  return screeningStatus(currentTree(project, currentReviewer, paper))
}

/**
 * The text a metadata-mode query word is matched against: title, authors,
 * DOI, abstract, PDF path and id. The PDF path is indexed whole, not just its
 * basename — a substring query like "smith-2021.pdf" already hits the full
 * path. `id`/`pdf` are non-optional on `Paper`, unlike `doi`/`abstract`, so
 * they need no empty-string fallback.
 */
function paperMetadataRaw(paper: Paper): string {
  return `${paper.title} ${paper.authors.join(' ')} ${paper.doi ?? ''} ${paper.abstract ?? ''} ${paper.pdf} ${paper.id}`
}

// [impl->req~lst-20~1]
// [impl->req~lst-25~1]
export function paperMetadataHaystack(paper: Paper): string {
  return paperMetadataRaw(paper).toLowerCase()
}

/**
 * One row of the list. `React.memo`'d because immer replaces only the edited
 * paper object on a field edit, so a memoized row skips re-rendering the
 * rest on every keystroke — but only as long as every prop stays a primitive
 * or identity-stable reference (hence a plain fill number, not `Completeness`,
 * and the store's stable `onSelect` action rather than a per-row closure).
 */
const PaperRow = memo(function PaperRow({
  paper,
  active,
  roving,
  onSelect,
  dotClassName,
  dotLabel,
  dotFill,
  seat,
  missing,
}: {
  paper: Paper
  seat: string | null
  missing: boolean
  active: boolean
  /** Whether this row is the list's one roving tab stop right now — see the
   *  `rovingId` comment in `PaperList` below. */
  roving: boolean
  onSelect: (id: string) => void
  dotClassName: string
  dotLabel: string
  dotFill: number | null
}) {
  // [impl->req~lst-20~1]
  // [impl->req~lst-25~1]
  // [impl->req~lst-90~1]
  const dotStyle = dotFill === null ? undefined : ({ '--fill': `${dotFill}%` } as CSSProperties)
  const meta = effectiveMetadata(paper, seat)
  const edited = editedFields(paper, seat)
  const badge = edited.length > 0 ? t('paperList.metadataBadge', { fields: edited.map((f) => t(`metadata.field.${f}`)).join(', ') }) : ''
  return (
    <li
      className={active ? 'paper active' : 'paper'}
      role="option"
      aria-selected={active}
      tabIndex={roving ? 0 : -1}
      data-paper-id={paper.id}
      onClick={() => onSelect(paper.id)}
    >
      {/* `role="img"` because a bare `title` on a `<span>` is not reliably
          announced; `aria-label` carries the same real numbers as the visual
          fill, so the meaning is not only in a hover-only tooltip. */}
      <span className={dotClassName} style={dotStyle} role="img" aria-label={dotLabel} title={dotLabel} />
      <span className="paper-info">
        <span className="paper-title">
          {meta.title}
          {edited.length > 0 && (
            <span
              className="paper-metadata-badge"
              role="img"
              aria-label={badge}
              title={badge}
            >
              ✎
            </span>
          )}
          {missing && (
            <span className="paper-metadata-badge" title={t('paperList.missingBadgeTitle')}>
              {t('paperList.missingBadge')}
            </span>
          )}
        </span>
        <span className="paper-authors">{meta.authors.join(', ')}</span>
      </span>
    </li>
  )
})

/** Left pane: the collapsible list of papers to annotate. */
export function PaperList() {
  const t = useT()
  const language = useLanguage()
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const missingPdfs = useStore((s) => s.missingPdfs)
  const selectPaper = useStore((s) => s.selectPaper)
  const screeningFilter = useStore((s) => s.screeningFilter)
  const setScreeningFilter = useStore((s) => s.setScreeningFilter)
  const annotationFilter = useStore((s) => s.annotationFilter)
  const setAnnotationFilter = useStore((s) => s.setAnnotationFilter)
  const schema = project?.schema ?? []
  const isScreening = project?.screening != null
  const isConsolidationSeat = (project?.reviewers ?? 1) > 1 && currentReviewer === 'consolidation'
  // Whether the dot's fill is a fraction of required fields or of every
  // field — see `completeness.ts`. Same for every row, so computed once here.
  const requiredMode = useMemo(() => hasRequiredFields(schema), [schema])

  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<SearchMode>('metadata')
  const [caseSensitive, setCaseSensitive] = useState(false)

  // Clear the search when a different project is opened — this component never
  // unmounts across a project change, so a stale query would hide every paper
  // in the new one. Keyed on `projectGeneration`, not `project`, which immer
  // replaces on every keystroke and would clear the box as you type.
  const generation = useStore((s) => s.projectGeneration)
  useEffect(() => {
    setQuery('')
    setMode('metadata')
    setCaseSensitive(false)
  }, [generation])

  // Build the search index once per project: one haystack per paper, per
  // mode. Keying on `papers` already invalidates this whenever annotation
  // content changes, since immer's `set` replaces the edited paper object.
  const person = useStore(activePerson)
  const allPapers = project?.papers
  const papers = useMemo(() => {
    if (!allPapers || !project || !person) return allPapers
    const mine = new Set(personPapers(project, person))
    return allPapers.filter((p) => mine.has(p.id))
  }, [allPapers, project, person])
  const index = useMemo<IndexedPaper[]>(() => {
    if (!papers || !project) return []
    const applies = completenessApplies(project)
    const required = hasRequiredFields(schema)
    return papers.map((paper) => {
      // The active reviewer's own tree, so the sidebar answers "did *I*
      // record this". Computed once and shared with `completeness` below —
      // `currentTree` is not free to build fresh per lookup over a large list.
      const tree = currentTree(project, currentReviewer, paper)
      const c = applies ? completeness(schema, tree) : null
      const touched = !!tree && hasAnnotations(schema, tree)
      return {
        paper,
        // Kept in original case (unlike the exported `paperMetadataHaystack`)
        // so the case-sensitive toggle below can match it directly.
        metadataHaystack: paperMetadataRaw(paper),
        annotationHaystack: annotationText(schema, tree ?? {}, true),
        completeness: c,
        touched,
        state: annotationState(
          c,
          currentFinished(project, currentReviewer, paper) === true,
          touched,
          required,
          project.finishCheckbox,
        ),
      }
    })
  }, [papers, project, schema, currentReviewer])

  // Corpus-wide progress, over every paper regardless of the current search —
  // "how far through this review am I", which no single row's dot answers.
  const progress = useMemo(() => {
    if (!project) return null
    const total = index.length
    if (isScreening) {
      const done = project.papers.filter(
        (p) => paperScreeningStatus(project, p, currentReviewer) !== 'undecided',
      ).length
      return { total, text: t('paperList.progress.screened', { done, total }) }
    }
    // Counts whichever bucket the filter dropdown is showing; with no filter
    // set it defaults to `finished`, the headline number of an annotation
    // project. Counted over every paper regardless of the search box, so it
    // can never disagree with the rows it's filtering.
    const bucket: Exclude<AnnotationFilter, 'all'> = annotationFilter === 'all' ? 'finished' : annotationFilter
    const done = index.filter((e) => matchesFilter(e.state, bucket, e.touched)).length
    const text = t(PROGRESS_KEY[bucket], { done, total })
    if (!isConsolidationSeat) return { total, text }
    // Consolidation also gets a readiness count (`paperIsMarkedDone`) — the
    // project-wide answer to "how much can I even start on".
    // [impl->req~lst-40~1]
    const ready = project.papers.filter((p) => paperIsMarkedDone(project, p, currentReviewer)).length
    return { total, text: t('paperList.progress.ready', { text, ready, total }) }
  }, [project, isScreening, isConsolidationSeat, currentReviewer, index, annotationFilter, language])

  // Filter + rank by how many distinct query words match (then matched chars).
  // Case-insensitive by default (both the query and haystack are lowercased);
  // the toggle below matches the raw, original-case haystack instead.
  const words = (caseSensitive ? query : query.toLowerCase()).split(/\s+/).filter((w) => w.length > 0)
  const filtered = useMemo<IndexedPaper[]>(() => {
    const base = index.filter((e) => {
      if (isScreening) {
        if (screeningFilter === 'all' || !project) return true
        return paperScreeningStatus(project, e.paper, currentReviewer) === screeningFilter
      }
      return matchesFilter(e.state, annotationFilter, e.touched)
    })
    if (words.length === 0) return base
    const scored = base
      .map((e, i) => {
        const raw = mode === 'annotations' ? e.annotationHaystack : e.metadataHaystack
        const haystack = caseSensitive ? raw : raw.toLowerCase()
        let matched = 0
        // [impl->req~lst-40~1]
        let chars = 0
        for (const w of words) {
          if (haystack.includes(w)) {
            matched++
            chars += w.length
          }
        }
        return { entry: e, matched, chars, i }
      })
      .filter((e) => e.matched > 0)
    scored.sort((a, b) => b.matched - a.matched || b.chars - a.chars || a.i - b.i)
    return scored.map((e) => e.entry)
    // `words` is derived from `query`/`caseSensitive`; keying on both is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, query, mode, caseSensitive, isScreening, screeningFilter, annotationFilter, project, currentReviewer])

  if (!project) return null

  const total = index.length
  const isFiltered =
    words.length > 0 || (isScreening ? screeningFilter !== 'all' : annotationFilter !== 'all')
  const countText = isFiltered ? t('paperList.count.ofTotal', { shown: filtered.length, total }) : `${total}`

  // The list's one roving tab stop (standard listbox keyboard pattern). The
  // open paper when still in view, else the first visible row, so a query
  // that scrolls it out of the filtered list doesn't leave no tab stop.
  const rovingId = filtered.some((e) => e.paper.id === currentPaperId)
    ? currentPaperId
    : (filtered[0]?.paper.id ?? null)

  // Arrow Up/Down moves selection *and* focus together — "select follows
  // focus", like a native `<select>`. Delegated to the list, not per-row, so
  // it doesn't defeat `PaperRow`'s memoization.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')
    if (!row) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Deliberately also covers Alt+Arrow (the global next/previous-paper
      // shortcut): useKeybindings.ts defers to us via e.defaultPrevented.
      e.preventDefault()
      // [impl->req~lst-10~1]
      const sib = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as
        | HTMLElement
        | null
      // [impl->req~lst-50~1]
      const id = sib?.dataset.paperId
      if (id) {
        selectPaper(id)
        sib.focus()
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      // [impl->req~lst-10~1]
      // [impl->req~lst-50~1]
      const id = row.dataset.paperId
      if (id) selectPaper(id)
    }
  }

  return (
    <div className="panel paper-list">
      <div className="paper-list-head">
        <div className="paper-list-title">
          <span>
            {t('paperList.title')} <span className="count">({countText})</span>
          </span>
          <SidebarToggle />
        </div>
        {progress && progress.total > 0 && <div className="paper-list-progress">{progress.text}</div>}
        <div className="paper-search">
          <input
            ref={searchInput}
            className="paper-search-input"
            type="text"
            placeholder={mode === 'annotations' ? t('paperList.search.annotationsPlaceholder') : t('paperList.search.papersPlaceholder')}
            aria-label={mode === 'annotations' ? t('paperList.search.annotationsLabel') : t('paperList.search.papersLabel')}
            // The trigger button is named by where it is, not its label: the
            // label reports the *current* mode, so "click TAGS to search
            // annotations" would read backwards while it says META.
            title={
              mode === 'annotations'
                ? t('paperList.search.annotationsTitle')
                : t('paperList.search.papersTitle')
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="paper-search-clear"
              title={t('paperList.search.clear')}
              aria-label={t('paperList.search.clear')}
              onClick={() => {
                setQuery('')
                // The button unmounts once the query is empty, which would drop
                // focus to <body>; keep it in the field for the next query.
                searchInput.current?.focus()
              }}
            >
              ×
            </button>
          )}
          <button
            type="button"
            className={`paper-search-case${caseSensitive ? ' active' : ''}`}
            title={caseSensitive ? t('paperList.case.onTitle') : t('paperList.case.offTitle')}
            aria-label={t('paperList.case.label')}
            aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive((c) => !c)}
          >
            Aa
          </button>
          <button
            type="button"
            className={`paper-search-mode${mode === 'annotations' ? ' active' : ''}`}
            title={mode === 'annotations' ? t('paperList.mode.annotationsTitle') : t('paperList.mode.metadataTitle')}
            aria-label={t('paperList.mode.label')}
            aria-pressed={mode === 'annotations'}
            onClick={() => setMode((m) => (m === 'metadata' ? 'annotations' : 'metadata'))}
          >
            {/* Same length in both states (and a fixed CSS width besides) so the
                trigger never reflows the input's padding — unlike the previous
                🔎/🏷 emoji pair, whose differing glyph widths visibly resized it. */}
            {mode === 'annotations' ? 'TAGS' : 'META'}
          </button>
        </div>
        {/* A dropdown rather than the segmented row screening uses: five
            states with prose labels don't fit across the sidebar's width. */}
        {!isScreening && (
          <select
            className={`annotation-filter${annotationFilter === 'all' ? '' : ' active'}`}
            aria-label={t('paperList.filter.label')}
            title={t('paperList.filter.title')}
            value={annotationFilter}
            onChange={(e) => setAnnotationFilter(e.target.value as AnnotationFilter)}
          >
            {annotationFiltersFor(project.finishCheckbox).map((f) => (
              <option key={f} value={f}>
                {t(FILTER_KEY[f])}
              </option>
            ))}
          </select>
        )}
        {isScreening && (
          <div className="screening-filter" role="group" aria-label={t('paperList.screening.label')}>
            {(['all', 'undecided', 'included', 'excluded'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`screening-filter-btn${screeningFilter === f ? ' active' : ''}`}
                aria-pressed={screeningFilter === f}
                onClick={() => setScreeningFilter(f)}
                title={t(SCREENING_SHOW_KEY[f])}
              >
                {t(SCREENING_LABEL_KEY[f])}
              </button>
            ))}
          </div>
        )}
      </div>
      <ul role="listbox" aria-label={t('paperList.title')} onKeyDown={onListKeyDown}>
        {filtered.length === 0 ? (
          <li className="paper-list-empty">
            {isFiltered
              ? mode === 'annotations'
                ? t('paperList.empty.annotations')
                : t('paperList.empty.matching')
              : t('paperList.empty.none')}
          </li>
        ) : (
          filtered.map((entry) => {
            const p = entry.paper
            const active = p.id === currentPaperId
            const isConsolidation = currentReviewer === 'consolidation' && project.reviewers > 1

            if (isScreening) {
              const status = paperScreeningStatus(project, p, currentReviewer)
              // Readiness moves into the tooltip here, since the marker itself
              // reports "the final decision so far" (see `paperScreeningStatus`).
              const readiness = isConsolidation
                ? readyToConsolidate(project.schema, p, project.reviewers)
                  ? t('paperList.screeningDot.readyToConsolidate')
                  : t('paperList.screeningDot.notAllScreened')
                : ''
              const title =
                (status === 'included'
                  ? t('paperList.screeningDot.included')
                  : status === 'excluded'
                    ? t('paperList.screeningDot.excluded')
                    : t('paperList.screeningDot.undecided')) + readiness
              return (
                <PaperRow
                  key={p.id}
                  paper={p}
                  active={active}
                  roving={p.id === rovingId}
                  onSelect={selectPaper}
                  seat={metadataSeatKey(project, person ? assignedSeat(project, p.id, person) : currentReviewer)}
                  missing={missingPdfs.includes(p.id)}
                  dotClassName={`status-dot screening-${status}`}
                  dotLabel={title}
                  dotFill={null}
                />
              )
            }

            // `entry.completeness` is never null here in practice (this line
            // means the screening branch above didn't return), but the type is
            // `Completeness | null` regardless, so fall back rather than assert.
            const c = entry.completeness ?? { filled: 0, total: 0 }
            const pct = completenessPercent(c)
            const state = entry.state ?? 'untouched'
            // The fill answers "how far" (the same pie-slice progress as
            // before); the state only decides color: amber = still to finish,
            // green = signed off, red = tick and data disagree.
            //
            // `pct === null` is the degenerate case a fraction can't describe
            // (boolean-only schema, or no tree in a multi-reviewer project with
            // nobody picked): falls back to the old fill-less marker.
            const fieldsLabel =
              pct === null
                ? entry.touched
                  ? t('paperList.dot.hasAnnotations')
                  : t('paperList.dot.notAnnotated')
                : requiredMode
                  ? t('paperList.dot.requiredFilled', { filled: c.filled, total: c.total })
                  : t('paperList.dot.filled', { filled: c.filled, total: c.total })
            // Readiness moves into the tooltip here too. Green means "I have
            // signed this off", not "everyone has answered it" — a consolidator
            // can finish a paper one reviewer never reached.
            const readiness = isConsolidation
              ? paperIsMarkedDone(project, p, currentReviewer)
                ? t('paperList.dot.allAnnotated')
                : t('paperList.dot.notAllAnnotated')
              : ''
            const finishBox = isConsolidation
              ? t('annotation.finished.checkboxConsolidation')
              : t('annotation.finished.checkbox')
            const dotLabel = `${dotStateLabel(state, finishBox)} — ${fieldsLabel}${readiness}`
            return (
              <PaperRow
                key={p.id}
                paper={p}
                active={active}
                roving={p.id === rovingId}
                onSelect={selectPaper}
                seat={metadataSeatKey(project, person ? assignedSeat(project, p.id, person) : currentReviewer)}
                missing={missingPdfs.includes(p.id)}
                dotClassName={`status-dot ${state}`}
                dotLabel={dotLabel}
                // Only the genuinely partial fills carry a percentage; the
                // endpoints are solid, and the degenerate `pct === null` case
                // uses the CSS fallback rather than inventing a number.
                dotFill={pct === null || pct === 0 || pct === 100 ? null : pct}
              />
            )
          })
        )}
      </ul>
    </div>
  )
}

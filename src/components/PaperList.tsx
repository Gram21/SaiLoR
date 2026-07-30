import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useStore, currentTree, currentFinished } from '../state/store'
import { hasAnnotations, annotationText } from '../model/annotations'
import { completeness, completenessPercent, hasRequiredFields, type Completeness } from '../model/completeness'
import {
  annotationState,
  annotationStateFor,
  completenessApplies,
  matchesFilter,
  ANNOTATION_FILTERS,
  ANNOTATION_FILTER_LABELS,
  type AnnotationFilter,
  type AnnotationState,
} from '../model/annotationState'
import { readyToConsolidate } from '../consolidate/readiness'
import { screeningStatus, type ScreeningStatus } from '../screening/status'
import { SidebarToggle } from './SidebarToggle'
import type { Paper, Project } from '../model/project'

/** Which text a query word is matched against. */
type SearchMode = 'metadata' | 'annotations'

/** The sentence each state's dot leads its tooltip/`aria-label` with, before
 *  the raw numbers. Spelled out rather than reusing the dropdown's terse
 *  option labels: this is the only place the color's *meaning* is stated, and
 *  it is the sole route to it for a screen reader. */
const DOT_LABELS: Record<AnnotationState, string> = {
  untouched: 'Not started',
  partial: 'In progress',
  complete: 'Ready to finish — tick "Annotation finished" in the panel',
  finished: 'Marked finished',
  flagged: 'Marked finished, but a required field is empty',
}

/** A paper paired with a precomputed, lowercased searchable string per mode. */
interface IndexedPaper {
  paper: Paper
  metadataHaystack: string
  annotationHaystack: string
  /** `null` when the fill does not apply to this seat — see `completenessApplies`. */
  completeness: Completeness | null
  /** `null` in the seats where completeness does not apply — the same seats
   *  `completeness` above is null for. */
  state: AnnotationState | null
}

/**
 * The completeness numbers behind a paper's dot fill, or `null` where it does
 * not apply — see `completenessApplies`. Exported standalone (mirroring
 * `paperIsMarkedDone`) so the gating logic has one home and is directly
 * unit-testable without rendering the list.
 */
export function paperCompleteness(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): Completeness | null {
  if (!completenessApplies(project, currentReviewer)) return null
  return completeness(project.schema, currentTree(project, currentReviewer, paper))
}

/**
 * A paper's annotation state for the active seat — the dot's color, what the
 * filter dropdown matches, and what the counter counts. `null` where
 * completeness does not apply (screening, Consolidation); see
 * `annotationState` for the states themselves.
 *
 * Always derived, never stored: only the reviewer's tick is persisted, so
 * emptying a field on a finished paper re-evaluates the mark by itself (it
 * becomes `flagged`), and refilling it restores `finished` — no separate
 * invalidation step exists that could be missed. Exported standalone
 * (mirroring `paperCompleteness` / `paperIsMarkedDone`) so this is directly
 * unit-testable without rendering the list.
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
    completenessApplies(project, currentReviewer),
  )
}

/** Shorthand for "green in the list": declared finished *and* still complete.
 *  Both halves are required — a full form is nobody's sign-off, and a
 *  sign-off does not survive the data it was about going away. */
export function paperIsFinished(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): boolean {
  return paperAnnotationState(project, paper, currentReviewer) === 'finished'
}

/**
 * Whether a paper's status dot should read as "done", per seat:
 *
 *  - single-reviewer, a numbered reviewer, or multi-reviewer-nobody-picked:
 *    unchanged from before this function existed — it is exactly
 *    `hasAnnotations` over the active seat's own tree (`currentTree`), so the
 *    dot answers "did *this* seat record anything".
 *  - Consolidation: `currentTree` for this seat is `paper.annotations`, but
 *    `adoptUnanimousValues` fills that tree just from opening the paper — its
 *    fullness stops meaning the consolidator did anything. What the dot means
 *    here instead is `readyToConsolidate`: every numbered reviewer has recorded
 *    something. That is well-defined independent of auto-adoption, and tells the
 *    consolidator which papers are actually workable — the same rule that
 *    decides whether a field's compare popup will open (see `Field.tsx`), so the
 *    list and the popups cannot disagree about which papers are ready.
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
 * The screening marker's state for a paper, per seat: `currentTree`'s
 * routing, so a numbered reviewer tracks their own decisions and
 * Consolidation tracks the result that ships.
 *
 * This deliberately replaces `paperIsMarkedDone`'s Consolidation meaning
 * (`readyToConsolidate`) for a screening project: with one decision per
 * paper, "the final decision so far" is the more useful thing for the marker
 * to say, and readiness has not been lost — it is in the marker's `title`
 * tooltip (see below), and the ⇄ compare button's readiness gate
 * (`Field.tsx`) is unchanged, which is the rule that actually protects the
 * consolidator from deciding on an absent reviewer.
 */
export function paperScreeningStatus(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): ScreeningStatus {
  return screeningStatus(currentTree(project, currentReviewer, paper))
}

/**
 * The lowercased text a metadata-mode query word is matched against.
 * Exported standalone (mirroring `paperCompleteness` / `paperIsMarkedDone`)
 * so it is directly unit-testable without rendering the list, and so the
 * list and its tests share one definition of "what counts as searchable".
 *
 * `pdf` is the project-relative path (e.g. "pdfs/smith-2021.pdf"); the whole
 * string is indexed. The basename is not indexed separately: matching is a
 * substring test over whitespace-split words, so a "smith-2021.pdf" (or
 * "pdfs/smith") query already hits the full path — a bare-basename entry
 * would only duplicate characters already present. `id` and `pdf` are
 * always present (non-optional on Paper), so unlike `doi`/`abstract` they
 * need no empty-string fallback.
 */
export function paperMetadataHaystack(paper: Paper): string {
  return `${paper.title} ${paper.authors.join(' ')} ${paper.doi ?? ''} ${paper.abstract ?? ''} ${paper.pdf} ${paper.id}`.toLowerCase()
}

/**
 * One row of the list. `React.memo`'d because immer's structural sharing
 * means a field edit (`setFieldValue` in `state/store.ts`) replaces only the
 * one paper object it touches — every other paper keeps its old identity — so
 * a memoized row re-renders only for the paper actually being edited, instead
 * of all of them on every keystroke. That only holds if every prop here is a
 * primitive or an identity-stable reference: an inline object or arrow
 * function passed in from the caller would look "new" every render and
 * silently defeat the memo without any test failing, so the dot's fill is
 * passed as a plain number, not the `Completeness` object, and `onSelect` is
 * the store's own stable action, not a per-row closure.
 */
const PaperRow = memo(function PaperRow({
  paper,
  active,
  roving,
  onSelect,
  dotClassName,
  dotLabel,
  dotFill,
}: {
  paper: Paper
  active: boolean
  /** Whether this row is the list's one roving tab stop right now — see the
   *  `rovingId` comment in `PaperList` below. */
  roving: boolean
  onSelect: (id: string) => void
  dotClassName: string
  dotLabel: string
  dotFill: number | null
}) {
  const dotStyle = dotFill === null ? undefined : ({ '--fill': `${dotFill}%` } as CSSProperties)
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
        <span className="paper-title">{paper.title}</span>
        <span className="paper-authors">{paper.authors.join(', ')}</span>
      </span>
    </li>
  )
})

/** Left pane: the collapsible list of papers to annotate. */
export function PaperList() {
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectPaper = useStore((s) => s.selectPaper)
  const screeningFilter = useStore((s) => s.screeningFilter)
  const setScreeningFilter = useStore((s) => s.setScreeningFilter)
  const annotationFilter = useStore((s) => s.annotationFilter)
  const setAnnotationFilter = useStore((s) => s.setAnnotationFilter)
  const schema = project?.schema ?? []
  const isScreening = project?.screening != null
  const isConsolidationSeat = (project?.reviewers ?? 1) > 1 && currentReviewer === 'consolidation'
  // Whether the dot's fill (where it applies at all) is a fraction of
  // *required* fields or of every field — see `completeness.ts`. Derived from
  // the schema alone, so it is the same for every row; computed once here
  // rather than per row.
  const requiredMode = useMemo(() => hasRequiredFields(schema), [schema])

  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('metadata')

  // Clear the search when a different project is opened. This component never
  // unmounts across a project change, so a query typed against the last project
  // stayed in the box and hid every paper in the new one behind "No matching
  // papers" — recoverable, since the query is visible, but it reads as an empty
  // project. Keyed on `projectGeneration` rather than on `project`, which immer
  // replaces on every keystroke and would clear the box as you type.
  const generation = useStore((s) => s.projectGeneration)
  useEffect(() => {
    setQuery('')
    setMode('metadata')
  }, [generation])

  // Build the search index once per project: one lowercased haystack per
  // paper, per mode. Annotation content changes as the reviewer types into a
  // field, not just when papers are added/removed — but the store's immer
  // `set` produces a new paper object (and therefore a new `papers` array)
  // on every such edit, so keying on `papers` already invalidates this memo
  // whenever annotation content actually changes. `schema` is included too:
  // it is what `annotationText` walks, even though it does not change here.
  // `currentReviewer` likewise: switching seats changes which tree is read.
  const papers = project?.papers
  const index = useMemo<IndexedPaper[]>(() => {
    if (!papers || !project) return []
    const applies = completenessApplies(project, currentReviewer)
    // Schema-wide, so it is hoisted out of the per-paper loop — the same
    // value `requiredMode` holds for the dot's denominator, recomputed here
    // rather than added to this memo's deps (it is derived from `schema`,
    // which is already a dep).
    const required = hasRequiredFields(schema)
    return papers.map((paper) => {
      // The active reviewer's own tree, so the sidebar answers "which papers
      // did *I* record this in" — the same tree the form and validation show.
      // Null (multi-reviewer, nobody picked yet) has no annotations to search
      // or count. Computed once and shared with `completeness` below rather
      // than looked up twice — `currentTree` builds a fresh normalized tree
      // when a numbered reviewer has never opened this paper, which is not
      // free to repeat over a large paper list.
      const tree = currentTree(project, currentReviewer, paper)
      const c = applies ? completeness(schema, tree) : null
      return {
        paper,
        // Searchable metadata: title, authors, DOI, abstract, PDF path and
        // id. Abstract is here because screening is decided on title +
        // abstract; the PDF path and id let a reviewer find a paper by the
        // file they remember or by its identifier. See `paperMetadataHaystack`.
        metadataHaystack: paperMetadataHaystack(paper),
        annotationHaystack: annotationText(schema, tree ?? {}),
        completeness: c,
        // Same inputs `paperAnnotationState` uses, off the tree and
        // completeness already computed here rather than walking them again
        // per row — a large paper list re-derives this on every keystroke.
        state: annotationState(
          c,
          currentFinished(project, currentReviewer, paper) === true,
          !!tree && hasAnnotations(schema, tree),
          required,
        ),
      }
    })
  }, [papers, project, schema, currentReviewer])

  // Corpus-wide progress, over every paper regardless of the current search —
  // "how far through this review am I", which nothing else in the app answers
  // (each row's own dot only reports itself). Mirrors the "done" meaning each
  // row already renders per mode, so it can never disagree with the dots.
  const progress = useMemo(() => {
    if (!project) return null
    const total = project.papers.length
    if (isScreening) {
      const done = project.papers.filter(
        (p) => paperScreeningStatus(project, p, currentReviewer) !== 'undecided',
      ).length
      return { total, text: `${done} of ${total} screened` }
    }
    if (project.reviewers > 1 && currentReviewer === 'consolidation') {
      const done = project.papers.filter((p) => paperIsMarkedDone(project, p, currentReviewer)).length
      return { total, text: `${done} of ${total} ready to consolidate` }
    }
    // Counts whichever bucket the filter dropdown is showing, so "finished:
    // 5/100" answers the question the reviewer just asked the list. With no
    // filter set it counts `finished` — the headline number of an annotation
    // project, and what this row said before the filter existed; counting
    // "all papers" there would only restate the total next to it. Either way
    // it counts by the same rule the rows are filtered by, over every paper
    // regardless of the search box, so the two can never disagree.
    const bucket: AnnotationFilter = annotationFilter === 'all' ? 'finished' : annotationFilter
    const done = index.filter((e) => matchesFilter(e.state, bucket)).length
    return { total, text: `${ANNOTATION_FILTER_LABELS[bucket]}: ${done}/${total}` }
  }, [project, isScreening, currentReviewer, index, annotationFilter])

  // Filter + rank by how many distinct query words match (then matched chars).
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  const filtered = useMemo<IndexedPaper[]>(() => {
    const base = index.filter((e) => {
      if (isScreening) {
        if (screeningFilter === 'all' || !project) return true
        return paperScreeningStatus(project, e.paper, currentReviewer) === screeningFilter
      }
      // `e.state` is null exactly where the dropdown is not rendered (the
      // Consolidation seat), and `matchesFilter` passes everything under
      // "all", so switching into that seat can never leave a filter set that
      // hides every paper.
      return matchesFilter(e.state, annotationFilter)
    })
    if (words.length === 0) return base
    const scored = base
      .map((e, i) => {
        const haystack = mode === 'annotations' ? e.annotationHaystack : e.metadataHaystack
        let matched = 0
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
    // `words` is derived from `query`; keying on both is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, query, mode, isScreening, screeningFilter, annotationFilter, project, currentReviewer])

  if (!project) return null

  const total = project.papers.length
  const isFiltered =
    words.length > 0 ||
    (isScreening ? screeningFilter !== 'all' : !isConsolidationSeat && annotationFilter !== 'all')
  const countText = isFiltered ? `${filtered.length} of ${total}` : `${total}`

  // The list's one roving tab stop (standard listbox keyboard pattern: Tab
  // enters/exits the whole list in one stop, Arrow keys move within it). The
  // open paper when it's still in view, else the first visible row — so a
  // query that scrolls the open paper out of the filtered list doesn't leave
  // the list with no tab stop at all.
  const rovingId = filtered.some((e) => e.paper.id === currentPaperId)
    ? currentPaperId
    : (filtered[0]?.paper.id ?? null)

  // Arrow Up/Down moves selection *and* focus together to the next/previous
  // visible row — "select follows focus", the same model a native `<select>`
  // uses, and simpler than tracking a separate unselected "focused" row when
  // every row already opens on click. Delegated to the list rather than
  // handled per-row so it costs nothing in the per-row memoization that keeps
  // large paper lists cheap to re-render (see `PaperRow`'s comment).
  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')
    if (!row) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const sib = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as
        | HTMLElement
        | null
      const id = sib?.dataset.paperId
      if (id) {
        selectPaper(id)
        sib.focus()
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const id = row.dataset.paperId
      if (id) selectPaper(id)
    }
  }

  return (
    <div className="panel paper-list">
      <div className="paper-list-head">
        <div className="paper-list-title">
          <span>
            Papers <span className="count">({countText})</span>
          </span>
          <SidebarToggle />
        </div>
        {progress && progress.total > 0 && <div className="paper-list-progress">{progress.text}</div>}
        <div className="paper-search">
          <input
            className="paper-search-input"
            type="text"
            placeholder={mode === 'annotations' ? 'Search annotations…' : 'Search papers…'}
            aria-label={mode === 'annotations' ? 'Search annotations' : 'Search papers'}
            // The field's own explanation, so what it is filtering is
            // discoverable without first noticing the small trigger inside it.
            // The trigger is named by where it is rather than by its label:
            // that label reports the *current* mode, so "click TAGS to search
            // annotations" would read as backwards while it says META.
            title={
              mode === 'annotations'
                ? 'Filters the list to papers whose recorded annotation values match — every word must match somewhere. Use the trigger inside this field to search titles, authors and DOIs instead.'
                : 'Filters the list to papers whose title, authors, DOI, PDF file name or id match — every word must match somewhere. Use the trigger inside this field to search your recorded annotations instead.'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className={`paper-search-mode${mode === 'annotations' ? ' active' : ''}`}
            title={
              mode === 'annotations'
                ? 'Searching annotation content (the values filled in for each paper). Click to search title, authors, and DOI instead.'
                : 'Searching title, authors, DOI, PDF file name, and id. Click to search annotation content (the values filled in for each paper) instead.'
            }
            aria-label="Toggle search mode between paper metadata and annotation content"
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
            states with prose labels do not fit across the sidebar's width,
            and unlike screening's three decisions these are read far less
            often than they are glanced at in the dots. Hidden in the
            Consolidation seat, whose papers have no annotation state
            (`completenessApplies`) — the readiness dot is the question there. */}
        {!isScreening && !isConsolidationSeat && (
          <select
            className={`annotation-filter${annotationFilter === 'all' ? '' : ' active'}`}
            aria-label="Filter by annotation state"
            title="Show only papers in one annotation state. The line above counts that state across the whole project."
            value={annotationFilter}
            onChange={(e) => setAnnotationFilter(e.target.value as AnnotationFilter)}
          >
            {ANNOTATION_FILTERS.map((f) => (
              <option key={f} value={f}>
                {ANNOTATION_FILTER_LABELS[f][0].toUpperCase() + ANNOTATION_FILTER_LABELS[f].slice(1)}
              </option>
            ))}
          </select>
        )}
        {isScreening && (
          <div className="screening-filter" role="group" aria-label="Filter by screening status">
            {(['all', 'undecided', 'included', 'excluded'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`screening-filter-btn${screeningFilter === f ? ' active' : ''}`}
                aria-pressed={screeningFilter === f}
                onClick={() => setScreeningFilter(f)}
              >
                {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>
      <ul role="listbox" aria-label="Papers" onKeyDown={onListKeyDown}>
        {filtered.length === 0 ? (
          <li className="paper-list-empty">
            {isFiltered
              ? mode === 'annotations'
                ? 'No papers with matching annotations'
                : 'No matching papers'
              : 'No papers'}
          </li>
        ) : (
          filtered.map((entry) => {
            const p = entry.paper
            const active = p.id === currentPaperId
            const isConsolidation = currentReviewer === 'consolidation' && project.reviewers > 1

            if (isScreening) {
              const status = paperScreeningStatus(project, p, currentReviewer)
              // Readiness has not been dropped for the consolidator here — it
              // moves into the tooltip, since the marker itself now reports
              // "the final decision so far" instead (see `paperScreeningStatus`).
              const readiness = isConsolidation
                ? readyToConsolidate(project.schema, p, project.reviewers)
                  ? ' — ready to consolidate'
                  : ' — not every reviewer has screened this yet'
                : ''
              const title =
                (status === 'included'
                  ? 'Included'
                  : status === 'excluded'
                    ? 'Excluded'
                    : 'Not screened yet') + readiness
              return (
                <PaperRow
                  key={p.id}
                  paper={p}
                  active={active}
                  roving={p.id === rovingId}
                  onSelect={selectPaper}
                  dotClassName={`status-dot screening-${status}`}
                  dotLabel={title}
                  dotFill={null}
                />
              )
            }

            // Progress is per-reviewer: as Reviewer 2 the dot must track *your*
            // work, not whatever the consolidated tree happens to hold. In the
            // Consolidation seat it means something else again — see
            // `paperIsMarkedDone`.
            const annotated = paperIsMarkedDone(project, p, currentReviewer)

            if (isConsolidation) {
              const title = annotated
                ? 'Ready to consolidate — every reviewer has annotated this paper'
                : 'Not ready — some reviewers have not annotated this paper yet'
              return (
                <PaperRow
                  key={p.id}
                  paper={p}
                  active={active}
                  roving={p.id === rovingId}
                  onSelect={selectPaper}
                  dotClassName={annotated ? 'status-dot done' : 'status-dot'}
                  dotLabel={title}
                  dotFill={null}
                />
              )
            }

            // The partial-fill dot. `entry.completeness` is never null here
            // in practice — reaching this line already means neither branch
            // above returned, and those two are exactly `completenessApplies`'s
            // negation — but the type is `Completeness | null` regardless
            // (the index computes it independently of this render's control
            // flow), so an empty fallback keeps this branch type-safe rather
            // than relying on an assertion. `pct === null` below covers the
            // remaining degenerate cases — a boolean-only schema, or no tree
            // at all (multi-reviewer, nobody picked) — by falling back to the
            // old binary dot rather than showing a meaningless 0%.
            const c = entry.completeness ?? { filled: 0, total: 0 }
            const pct = completenessPercent(c)
            const state = entry.state ?? 'untouched'
            // The dot keeps showing *progress* exactly as before — the same
            // pie-slice fill over the same numbers — and the state only
            // decides its color: amber while the paper is still the
            // reviewer's to finish, green once they tick the box, red when
            // the tick and the data disagree. So the fill answers "how far",
            // the color answers "whose move is it", and neither has to be
            // read out of the other.
            //
            // `pct === null` is the degenerate case a fraction cannot
            // describe (a boolean-only schema, or no tree at all in a
            // multi-reviewer project with nobody picked): there the dot falls
            // back to a fill-less marker, the same as before.
            const fieldsLabel =
              pct === null
                ? annotated
                  ? 'Has annotations'
                  : 'Not annotated yet'
                : `${c.filled} of ${c.total} ${requiredMode ? 'required ' : ''}fields filled`
            const dotLabel = `${DOT_LABELS[state]} — ${fieldsLabel}`
            return (
              <PaperRow
                key={p.id}
                paper={p}
                active={active}
                roving={p.id === rovingId}
                onSelect={selectPaper}
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

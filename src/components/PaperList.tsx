import { memo, useMemo, useState, type CSSProperties } from 'react'
import { useStore, currentTree } from '../state/store'
import { hasAnnotations, annotationText } from '../model/annotations'
import { completeness, completenessPercent, hasRequiredFields, type Completeness } from '../model/completeness'
import { readyToConsolidate } from '../consolidate/readiness'
import { screeningStatus, type ScreeningStatus } from '../screening/status'
import { SidebarToggle } from './SidebarToggle'
import type { Paper, Project } from '../model/project'

/** Which text a query word is matched against. */
type SearchMode = 'metadata' | 'annotations'

/** A paper paired with a precomputed, lowercased searchable string per mode. */
interface IndexedPaper {
  paper: Paper
  metadataHaystack: string
  annotationHaystack: string
  /** `null` when the fill does not apply to this seat — see `completenessApplies`. */
  completeness: Completeness | null
}

/**
 * Whether the completeness dot's partial fill applies to this seat at all.
 *
 * A screening project already has its own tri-state included/excluded/
 * undecided marker (`paperScreeningStatus`); the derived screening schema
 * marks nothing required, so a fill would fall back to counting both of its
 * fields (Decision, Reason) — meaning an "Include" decision, which needs no
 * Reason, would render as a half-full dot for a paper that is actually done.
 * The Consolidation seat's dot means *readiness* (`paperIsMarkedDone`), a
 * different question ("has every reviewer answered") that a per-field fill
 * cannot express without conflating it with how much Consolidation itself
 * has typed — so it keeps its own binary dot instead.
 */
function completenessApplies(project: Project, currentReviewer: string | null): boolean {
  if (project.screening != null) return false
  if (project.reviewers > 1 && currentReviewer === 'consolidation') return false
  return true
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
  onSelect,
  dotClassName,
  dotLabel,
  dotFill,
}: {
  paper: Paper
  active: boolean
  onSelect: (id: string) => void
  dotClassName: string
  dotLabel: string
  dotFill: number | null
}) {
  const dotStyle = dotFill === null ? undefined : ({ '--fill': `${dotFill}%` } as CSSProperties)
  return (
    <li className={active ? 'paper active' : 'paper'} onClick={() => onSelect(paper.id)}>
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
  const schema = project?.schema ?? []
  const isScreening = project?.screening != null
  // Whether the dot's fill (where it applies at all) is a fraction of
  // *required* fields or of every field — see `completeness.ts`. Derived from
  // the schema alone, so it is the same for every row; computed once here
  // rather than per row.
  const requiredMode = useMemo(() => hasRequiredFields(schema), [schema])

  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('metadata')

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
    return papers.map((paper) => {
      // The active reviewer's own tree, so the sidebar answers "which papers
      // did *I* record this in" — the same tree the form and validation show.
      // Null (multi-reviewer, nobody picked yet) has no annotations to search
      // or count. Computed once and shared with `completeness` below rather
      // than looked up twice — `currentTree` builds a fresh normalized tree
      // when a numbered reviewer has never opened this paper, which is not
      // free to repeat over a large paper list.
      const tree = currentTree(project, currentReviewer, paper)
      return {
        paper,
        // Searchable metadata: title, authors, DOI, abstract, PDF path and
        // id. Abstract is here because screening is decided on title +
        // abstract; the PDF path and id let a reviewer find a paper by the
        // file they remember or by its identifier. See `paperMetadataHaystack`.
        metadataHaystack: paperMetadataHaystack(paper),
        annotationHaystack: annotationText(schema, tree ?? {}),
        completeness: applies ? completeness(schema, tree) : null,
      }
    })
  }, [papers, project, schema, currentReviewer])

  // Filter + rank by how many distinct query words match (then matched chars).
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  const filtered = useMemo<IndexedPaper[]>(() => {
    const base = index.filter((e) => {
      if (!isScreening || screeningFilter === 'all' || !project) return true
      return paperScreeningStatus(project, e.paper, currentReviewer) === screeningFilter
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
  }, [index, query, mode, isScreening, screeningFilter, project, currentReviewer])

  if (!project) return null

  const total = project.papers.length
  const isFiltered = words.length > 0 || (isScreening && screeningFilter !== 'all')
  const countText = isFiltered ? `${filtered.length} of ${total}` : `${total}`

  return (
    <div className="panel paper-list">
      <div className="paper-list-head">
        <div className="paper-list-title">
          <span>
            Papers <span className="count">({countText})</span>
          </span>
          <SidebarToggle />
        </div>
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
      <ul>
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
            if (pct === null) {
              const title = annotated ? 'Has annotations' : 'Not annotated yet'
              return (
                <PaperRow
                  key={p.id}
                  paper={p}
                  active={active}
                  onSelect={selectPaper}
                  dotClassName={annotated ? 'status-dot done' : 'status-dot'}
                  dotLabel={title}
                  dotFill={null}
                />
              )
            }
            // 0% and 100% reuse the exact pre-existing classes, so the two
            // endpoints render pixel-identical to the dot's previous
            // touched/untouched meaning; only genuinely partial states get
            // the new conic-gradient fill.
            const dotClassName =
              pct === 0 ? 'status-dot' : pct === 100 ? 'status-dot done' : 'status-dot partial'
            const dotLabel = `${c.filled} of ${c.total} ${requiredMode ? 'required ' : ''}fields filled`
            return (
              <PaperRow
                key={p.id}
                paper={p}
                active={active}
                onSelect={selectPaper}
                dotClassName={dotClassName}
                dotLabel={dotLabel}
                dotFill={pct === 0 || pct === 100 ? null : pct}
              />
            )
          })
        )}
      </ul>
    </div>
  )
}

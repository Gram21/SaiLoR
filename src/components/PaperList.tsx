import { useMemo, useState } from 'react'
import { useStore, currentTree } from '../state/store'
import { hasAnnotations, annotationText } from '../model/annotations'
import { SidebarToggle } from './SidebarToggle'
import type { Paper, Project } from '../model/project'

/** Which text a query word is matched against. */
type SearchMode = 'metadata' | 'annotations'

/** A paper paired with a precomputed, lowercased searchable string per mode. */
interface IndexedPaper {
  paper: Paper
  metadataHaystack: string
  annotationHaystack: string
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
 *    here instead is "ready to consolidate": every numbered reviewer 1..N has
 *    annotated. That is well-defined independent of auto-adoption, and tells
 *    the consolidator which papers are actually workable.
 */
export function paperIsMarkedDone(
  project: Project,
  paper: Paper,
  currentReviewer: string | null,
): boolean {
  if (project.reviewers > 1 && currentReviewer === 'consolidation') {
    for (let i = 1; i <= project.reviewers; i++) {
      const tree = paper.reviews[String(i)]
      if (!tree || !hasAnnotations(project.schema, tree)) return false
    }
    return true
  }
  const tree = currentTree(project, currentReviewer, paper)
  return !!tree && hasAnnotations(project.schema, tree)
}

/** Left pane: the collapsible list of papers to annotate. */
export function PaperList() {
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectPaper = useStore((s) => s.selectPaper)
  const schema = project?.schema ?? []

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
    return papers.map((paper) => ({
      paper,
      metadataHaystack: `${paper.title} ${paper.authors.join(' ')} ${paper.doi ?? ''}`.toLowerCase(),
      // The active reviewer's own tree, so the sidebar answers "which papers
      // did *I* record this in" — the same tree the form and validation show.
      // Null (multi-reviewer, nobody picked yet) has no annotations to search.
      annotationHaystack: annotationText(schema, currentTree(project, currentReviewer, paper) ?? {}),
    }))
  }, [papers, project, schema, currentReviewer])

  // Filter + rank by how many distinct query words match (then matched chars).
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  const filtered = useMemo<Paper[]>(() => {
    if (words.length === 0) return index.map((e) => e.paper)
    const scored = index
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
        return { paper: e.paper, matched, chars, i }
      })
      .filter((e) => e.matched > 0)
    scored.sort((a, b) => b.matched - a.matched || b.chars - a.chars || a.i - b.i)
    return scored.map((e) => e.paper)
    // `words` is derived from `query`; keying on both is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, query, mode])

  if (!project) return null

  const total = project.papers.length
  const isFiltered = words.length > 0
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
                : 'Filters the list to papers whose title, authors or DOI match — every word must match somewhere. Use the trigger inside this field to search your recorded annotations instead.'
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
                : 'Searching title, authors, and DOI. Click to search annotation content (the values filled in for each paper) instead.'
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
          filtered.map((p) => {
            // Progress is per-reviewer: as Reviewer 2 the dot must track *your*
            // work, not whatever the consolidated tree happens to hold. In the
            // Consolidation seat it means something else again — see
            // `paperIsMarkedDone`.
            const annotated = paperIsMarkedDone(project, p, currentReviewer)
            const isConsolidation = currentReviewer === 'consolidation' && project.reviewers > 1
            const title = isConsolidation
              ? annotated
                ? 'Ready to consolidate — every reviewer has annotated this paper'
                : 'Not ready — some reviewers have not annotated this paper yet'
              : annotated
                ? 'Has annotations'
                : 'Not annotated yet'
            return (
              <li
                key={p.id}
                className={p.id === currentPaperId ? 'paper active' : 'paper'}
                onClick={() => selectPaper(p.id)}
              >
                <span className={annotated ? 'status-dot done' : 'status-dot'} title={title} />
                <span className="paper-info">
                  <span className="paper-title">{p.title}</span>
                  <span className="paper-authors">{p.authors.join(', ')}</span>
                </span>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { hasAnnotations, annotationText } from '../model/annotations'
import { SidebarToggle } from './SidebarToggle'
import type { Paper } from '../model/project'

/** Which text a query word is matched against. */
type SearchMode = 'metadata' | 'annotations'

/** A paper paired with a precomputed, lowercased searchable string per mode. */
interface IndexedPaper {
  paper: Paper
  metadataHaystack: string
  annotationHaystack: string
}

/** Left pane: the collapsible list of papers to annotate. */
export function PaperList() {
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
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
  const papers = project?.papers
  const index = useMemo<IndexedPaper[]>(() => {
    if (!papers) return []
    return papers.map((paper) => ({
      paper,
      metadataHaystack: `${paper.title} ${paper.authors.join(' ')} ${paper.doi ?? ''}`.toLowerCase(),
      // Searches `paper.annotations` — the single-reviewer tree. If a
      // per-reviewer tree structure lands later, this is the spot to revisit.
      annotationHaystack: annotationText(schema, paper.annotations),
    }))
  }, [papers, schema])

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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className={`icon-btn paper-search-mode${mode === 'annotations' ? ' active' : ''}`}
            title={
              mode === 'annotations'
                ? 'Searching annotation content (the values filled in for each paper). Click to search title, authors, and DOI instead.'
                : 'Searching title, authors, and DOI. Click to search annotation content (the values filled in for each paper) instead.'
            }
            aria-label="Toggle search mode between paper metadata and annotation content"
            aria-pressed={mode === 'annotations'}
            onClick={() => setMode((m) => (m === 'metadata' ? 'annotations' : 'metadata'))}
          >
            {mode === 'annotations' ? '🏷' : '🔎'}
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
            const annotated = hasAnnotations(schema, p.annotations)
            return (
              <li
                key={p.id}
                className={p.id === currentPaperId ? 'paper active' : 'paper'}
                onClick={() => selectPaper(p.id)}
              >
                <span
                  className={annotated ? 'status-dot done' : 'status-dot'}
                  title={annotated ? 'Has annotations' : 'Not annotated yet'}
                />
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

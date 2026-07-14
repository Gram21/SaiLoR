import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { hasAnnotations } from '../model/annotations'
import { SidebarToggle } from './SidebarToggle'
import type { Paper } from '../model/project'

/** A paper paired with a precomputed, lowercased searchable string. */
interface IndexedPaper {
  paper: Paper
  haystack: string
}

/** Left pane: the collapsible list of papers to annotate. */
export function PaperList() {
  const project = useStore((s) => s.project)
  const currentPaperId = useStore((s) => s.currentPaperId)
  const selectPaper = useStore((s) => s.selectPaper)
  const schema = project?.schema ?? []

  const [query, setQuery] = useState('')

  // Build the search index once per project: one lowercased haystack per paper.
  const papers = project?.papers
  const index = useMemo<IndexedPaper[]>(() => {
    if (!papers) return []
    return papers.map((paper) => ({
      paper,
      haystack: `${paper.title} ${paper.authors.join(' ')} ${paper.doi ?? ''}`.toLowerCase(),
    }))
  }, [papers])

  // Filter + rank by how many distinct query words match (then matched chars).
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0)
  const filtered = useMemo<Paper[]>(() => {
    if (words.length === 0) return index.map((e) => e.paper)
    const scored = index
      .map((e, i) => {
        let matched = 0
        let chars = 0
        for (const w of words) {
          if (e.haystack.includes(w)) {
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
  }, [index, query])

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
            placeholder="Search papers…"
            aria-label="Search papers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <ul>
        {filtered.length === 0 ? (
          <li className="paper-list-empty">No matching papers</li>
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

import { graphSeats, CONSOLIDATION } from '../model/graph'
import { seatLabel, type Project } from '../model/project'
import { useT } from '../i18n'

/** Picks the source of the graph: a reviewer seat, or the consolidation once one was saved. Renders nothing with one reviewer. */
export function GraphSeatSelect({
  project,
  value,
  onChange,
  disabled,
}: {
  project: Project
  value: string
  onChange: (seat: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const seats = graphSeats(project)
  if (seats.length === 0) return null
  return (
    <label>
      <span>{t('exportGraph.seat')} </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {seats.map((s) => (
          <option key={s} value={s}>
            {s === CONSOLIDATION ? t('exportGraph.consolidation') : seatLabel(project, s)}
          </option>
        ))}
      </select>
    </label>
  )
}

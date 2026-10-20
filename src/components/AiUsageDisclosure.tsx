import type { AiUsageRecord, Project } from '../model/project'
import { seatLabel } from '../model/project'
import { PROVIDERS } from '../llm/providers'

function providerLabel(id: string): string {
  return (PROVIDERS as Record<string, { label: string } | undefined>)[id]?.label ?? id
}

interface Props {
  project: Pick<Project, 'aiSeat' | 'aiEnabled' | 'reviewers' | 'screening'>
  records: AiUsageRecord[]
}

/**
 * The AI-usage disclosure in the annotation panel header: a compact count
 * that expands (`<details>`) into one line per run, so a reviewer or
 * consolidator can see how this paper's values were produced. Hidden
 * entirely when there is nothing this seat should see — see the caller's
 * seat filtering (`AnnotationPanel.tsx`'s `relevantAiUsage`).
 */
export function AiUsageDisclosure({ project, records }: Props) {
  if (records.length === 0) return null
  return (
    <details className="ai-usage-disclosure">
      <summary>✦ AI-assisted ({records.length}×)</summary>
      <ul>
        {records.map((r, i) => (
          <li key={i}>
            {new Date(r.appliedAt).toLocaleString()} — {r.mode ?? 'prompt'} — {providerLabel(r.provider)} · {r.model}
            {r.judge && (
              <>
                {' '}— judge {providerLabel(r.judge.provider)} · {r.judge.model}
              </>
            )}
            {typeof r.rounds === 'number' && <> — {r.rounds} round{r.rounds === 1 ? '' : 's'}</>}
            {r.verdicts && (
              <>
                {' '}— {r.verdicts.accept} accepted, {r.verdicts.revise} revised, {r.verdicts.reject} rejected
              </>
            )}
            {typeof r.fewShot === 'number' && r.fewShot > 0 && (
              <> — {r.fewShot} example{r.fewShot === 1 ? '' : 's'}</>
            )}
            {typeof r.edited === 'number' && r.edited > 0 && (
              <> — {r.edited} edited</>
            )}
            {typeof r.rechecked === 'number' && r.rechecked > 0 && <> — {r.rechecked} replaced</>}
            {typeof r.webSearches === 'number' && r.webSearches > 0 && (
              <> — {r.webSearches} web search{r.webSearches === 1 ? '' : 'es'}</>
            )}
            {r.reviewer && <> — {seatLabel(project, r.reviewer)}</>}
          </li>
        ))}
      </ul>
    </details>
  )
}

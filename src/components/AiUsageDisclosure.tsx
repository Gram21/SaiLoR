// [impl->req~llm-240~1]
// [impl->req~llm-570~1]
// [impl->req~llm-580~1]
// [impl->req~llm-660~1]
// [impl->req~llm-670~1]
// [impl->req~llm-770~1]
import type { AiUsageRecord, Project } from '../model/project'
import { seatLabel } from '../model/project'
import { PROVIDERS } from '../llm/providers'
import { useT, tp, getLanguage } from '../i18n'

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
  const t = useT()
  if (records.length === 0) return null
  return (
    <details className="ai-usage-disclosure">
      <summary>{t('ai.usageDisclosure.summary', { count: records.length })}</summary>
      <ul>
        {records.map((r, i) => (
          <li key={i}>
            {new Date(r.appliedAt).toLocaleString(getLanguage())} — {r.mode ?? 'prompt'} — {providerLabel(r.provider)} · {r.model}
            {r.judge && (
              <>
                {' '}— {t('ai.usageDisclosure.judge', { provider: providerLabel(r.judge.provider), model: r.judge.model })}
              </>
            )}
            {typeof r.rounds === 'number' && <> — {tp('ai.usageDisclosure.rounds', r.rounds)}</>}
            {r.verdicts && (
              <>
                {' '}— {t('ai.usageDisclosure.verdicts', { accepted: r.verdicts.accept, revised: r.verdicts.revise, rejected: r.verdicts.reject })}
              </>
            )}
            {typeof r.fewShot === 'number' && r.fewShot > 0 && (
              <> — {tp('ai.usageDisclosure.examples', r.fewShot)}</>
            )}
            {typeof r.edited === 'number' && r.edited > 0 && (
              <> — {t('ai.usageDisclosure.edited', { count: r.edited })}</>
            )}
            {typeof r.rechecked === 'number' && r.rechecked > 0 && <> — {t('ai.usageDisclosure.replaced', { count: r.rechecked })}</>}
            {typeof r.webSearches === 'number' && r.webSearches > 0 && (
              <> — {tp('ai.usage.webSearches', r.webSearches)}</>
            )}
            {typeof r.unverifiedQuotes === 'number' && r.unverifiedQuotes > 0 && (
              <> — {t('ai.usageDisclosure.unverifiedQuotes', { count: r.unverifiedQuotes })}</>
            )}
            {r.reviewer && <> — {seatLabel(project, r.reviewer)}</>}
          </li>
        ))}
      </ul>
    </details>
  )
}

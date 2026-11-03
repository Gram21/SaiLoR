// [impl->req~llm-732~1]
import type { LlmConfig } from '../llm/types'
import { useT } from '../i18n'

/**
 * Editable context window (and, for System One, the question/option budget).
 * Both are in tokens — roughly three quarters of a word each.
 */
export function ContextFields({
  draft,
  patch,
  label,
}: {
  draft: LlmConfig
  patch: (c: Partial<LlmConfig>) => void
  label?: string
}) {
  const t = useT()
  const num = (v: string) => (v === '' ? undefined : Number(v))
  return (
    <>
      <div className="llm-row">
        <label htmlFor="llm-context" className="llm-label">
          {label ?? t('field.context.window')}
        </label>
        <input
          id="llm-context"
          type="number"
          min="1"
          step="1"
          value={draft.contextTokens ?? ''}
          onChange={(e) => patch({ contextTokens: num(e.target.value) })}
        />
      </div>
      <p className="llm-hint">{t('field.context.hint')}</p>
      {draft.provider === 'systemone' && (
        <>
          <div className="llm-row">
            <label htmlFor="llm-options-budget" className="llm-label">
              {t('field.context.budget')}
            </label>
            <input
              id="llm-options-budget"
              type="number"
              min="1"
              step="1"
              value={draft.optionsBudgetTokens ?? ''}
              onChange={(e) => patch({ optionsBudgetTokens: num(e.target.value) })}
            />
          </div>
          <p className="llm-hint">{t('field.context.budgetHint')}</p>
        </>
      )}
    </>
  )
}

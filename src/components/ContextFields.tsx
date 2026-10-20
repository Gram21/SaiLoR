import type { LlmConfig } from '../llm/types'

/**
 * Editable context window (and, for System One, the question/option budget).
 * Both are in tokens — roughly three quarters of a word each.
 */
export function ContextFields({
  draft,
  patch,
  label = 'Context window (tokens)',
}: {
  draft: LlmConfig
  patch: (c: Partial<LlmConfig>) => void
  label?: string
}) {
  const num = (v: string) => (v === '' ? undefined : Number(v))
  return (
    <>
      <div className="llm-row">
        <label htmlFor="llm-context" className="llm-label">
          {label}
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
      <p className="llm-hint">
        How much text the model can read at once, in tokens (about ¾ of a word each). The paper is
        trimmed to fit; leave empty if unknown.
      </p>
      {draft.provider === 'systemone' && (
        <>
          <div className="llm-row">
            <label htmlFor="llm-options-budget" className="llm-label">
              Question &amp; options budget (tokens)
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
          <p className="llm-hint">
            Share of the window for each question and its answer options. Longer ones are cut, so
            keep field names and options short.
          </p>
        </>
      )}
    </>
  )
}

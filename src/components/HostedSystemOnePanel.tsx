import type { LlmConfig } from '../llm/types'
import { systemOneProfileFor } from '../llm/modelProfiles'
import { isCloudflareAccountId } from '../llm/localUi'

export const JEV_URL = 'https://api.typesafe.ai'

/** Config changes that switch a draft between Jev and Clef on Cloudflare; contextTokens follows the profile. */
export function hostedPreset(base: LlmConfig, flavor: 'jev' | 'cloudflare', model?: string): LlmConfig {
  const next: LlmConfig =
    flavor === 'cloudflare'
      ? { ...base, provider: 'systemone', systemOneFlavor: 'cloudflare', model: model ?? 'clef-flash', baseUrl: JEV_URL }
      : { ...base, provider: 'systemone', systemOneFlavor: undefined, accountId: undefined, model: model ?? 'jev-latest', baseUrl: JEV_URL }
  return {
    ...next,
    managed: undefined,
    noKey: false,
    maxStateTokens: undefined,
    contextTokens: systemOneProfileFor({ ...next, contextTokens: undefined }).contextTokens,
    optionsBudgetTokens: undefined,
  }
}

/** Jev (own generic URL/model rows) or Clef on Cloudflare Workers AI. The API key uses the dialog's key field. */
export function HostedSystemOnePanel({ draft, replace }: { draft: LlmConfig; replace: (c: LlmConfig) => void }) {
  const cf = draft.systemOneFlavor === 'cloudflare'
  const account = draft.accountId ?? ''
  const accountBad = cf && account !== '' && !isCloudflareAccountId(account)
  return (
    <>
      <div className="llm-row">
        <label htmlFor="llm-s1-flavor" className="llm-label">
          Service
        </label>
        <select
          id="llm-s1-flavor"
          value={cf ? 'cloudflare' : 'jev'}
          onChange={(e) => replace(hostedPreset(draft, e.target.value as 'jev' | 'cloudflare'))}
        >
          <option value="cloudflare">Clef / Clef-flash (Cloudflare Workers AI)</option>
          <option value="jev">Jev (TypeSafe)</option>
        </select>
      </div>
      {cf ? (
        <>
          <div className="llm-row">
            <label htmlFor="llm-cf-account" className="llm-label">
              Account ID
            </label>
            <input
              id="llm-cf-account"
              type="text"
              autoComplete="off"
              value={account}
              aria-invalid={accountBad}
              onChange={(e) => replace({ ...draft, accountId: e.target.value.trim() })}
              placeholder="32 hex characters"
            />
          </div>
          <p className={accountBad ? 'llm-hint llm-status-error' : 'llm-hint'}>
            {accountBad
              ? 'An account ID is 32 lowercase hex characters (0-9, a-f).'
              : 'A public ID, not a secret — find it in the Cloudflare dashboard. The API token goes in the key field below.'}
          </p>
          <div className="llm-row">
            <label htmlFor="llm-cf-model" className="llm-label">
              Model
            </label>
            <select id="llm-cf-model" value={draft.model} onChange={(e) => replace(hostedPreset(draft, 'cloudflare', e.target.value))}>
              <option value="clef-flash">clef-flash (9B, cheaper)</option>
              <option value="clef">clef (27B)</option>
            </select>
          </div>
          <p className="llm-hint">
            Limits: 64k-token context, at most 64 questions per request. Roughly $0.09–0.24 per
            million input tokens — check Cloudflare's pricing page for the current rate.
          </p>
        </>
      ) : (
        <p className="llm-hint llm-wide">
          TypeSafe's hosted Jev: default URL {JEV_URL}, model jev-latest, plus your API key.
        </p>
      )}
    </>
  )
}

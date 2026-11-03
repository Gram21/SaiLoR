// [impl->req~llm-733~1]
import type { LlmConfig } from '../llm/types'
import { useT } from '../i18n'
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
  const t = useT()
  const cf = draft.systemOneFlavor === 'cloudflare'
  const account = draft.accountId ?? ''
  const accountBad = cf && account !== '' && !isCloudflareAccountId(account)
  return (
    <>
      <div className="llm-row">
        <label htmlFor="llm-s1-flavor" className="llm-label">
          {t('llm.hosted.service')}
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
              {t('llm.hosted.accountId')}
            </label>
            <input
              id="llm-cf-account"
              type="text"
              autoComplete="off"
              value={account}
              aria-invalid={accountBad}
              onChange={(e) => replace({ ...draft, accountId: e.target.value.trim() })}
              placeholder={t('llm.hosted.accountPlaceholder')}
            />
          </div>
          <p className={accountBad ? 'llm-hint llm-status-error' : 'llm-hint'}>
            {accountBad ? t('llm.hosted.accountInvalid') : t('llm.hosted.accountHint')}
          </p>
          <div className="llm-row">
            <label htmlFor="llm-cf-model" className="llm-label">
              {t('llm.settings.model')}
            </label>
            <select id="llm-cf-model" value={draft.model} onChange={(e) => replace(hostedPreset(draft, 'cloudflare', e.target.value))}>
              <option value="clef-flash">{t('llm.hosted.clefFlashOption')}</option>
              <option value="clef">clef (27B)</option>
            </select>
          </div>
          <p className="llm-hint">{t('llm.hosted.cfLimits')}</p>
        </>
      ) : (
        <p className="llm-hint llm-wide">
          {t('llm.hosted.jevHint', { url: JEV_URL })}
        </p>
      )}
    </>
  )
}

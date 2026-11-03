// [impl->req~llm-730~1]
import { useEffect, useState } from 'react'
import { getPlatform } from '../platform'
import { LOCAL_MODEL_CATALOG, type LocalModelEntry } from '../llm/localCatalog'
import { backendName, formatBytes, hardwareSentence, windowSentence } from '../llm/localUi'
import type { LlmConfig } from '../llm/types'
import type {
  HardwareInfo,
  InstalledModel,
  LocalProgress,
  LocalRuntimeApi,
  LocalServerInfo,
  ModelPlan,
  RuntimePlan,
  RuntimeStatus,
} from '../platform/localRuntime'
import { useT, type MessageKey } from '../i18n'
import { Bar, ConsentBox, Unavailable } from './LocalBits'

export const NO_RELEASE_YET: MessageKey = 'llm.s1.noRelease'

const MODELS = LOCAL_MODEL_CATALOG.filter((e) => e.kind === 'systemone')
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Consent = { kind: 'runtime'; plan: RuntimePlan } | { kind: 'model'; plan: ModelPlan; entry: LocalModelEntry }

/** Managed local System One: hardware, llama.cpp runtime, model downloads, and a self-run server fallback. */
export function LocalSystemOnePanel(props: { draft: LlmConfig; patch: (c: Partial<LlmConfig>) => void }) {
  const rt = getPlatform().localRuntime
  return rt ? <Panel rt={rt} {...props} /> : <Unavailable />
}

function Panel({ rt, draft, patch }: { rt: LocalRuntimeApi; draft: LlmConfig; patch: (c: Partial<LlmConfig>) => void }) {
  const t = useT()
  const [hw, setHw] = useState<HardwareInfo | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [installed, setInstalled] = useState<InstalledModel[]>([])
  const [consent, setConsent] = useState<Consent | null>(null)
  const [progress, setProgress] = useState<Record<string, LocalProgress>>({})
  const [servers, setServers] = useState<Record<string, LocalServerInfo | 'starting'>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    rt.probe().then(setHw, () => {})
    rt.runtime().then(setRuntime, () => {})
    rt.installed().then(setInstalled, () => {})
    return rt.onProgress((p) => setProgress((s) => ({ ...s, [p.id]: p })))
  }, [rt])

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(msg(e))
    }
  }

  const askRuntime = () => run(async () => setConsent({ kind: 'runtime', plan: await rt.runtimePlan() }))
  const askModel = (entry: LocalModelEntry) =>
    run(async () => setConsent({ kind: 'model', entry, plan: await rt.modelPlan(entry.id) }))

  const confirm = () => {
    const c = consent
    setConsent(null)
    if (!c) return
    void run(async () => {
      if (c.kind === 'runtime') setRuntime(await rt.runtimeInstall())
      else {
        await rt.modelInstall(c.entry.id)
        setInstalled(await rt.installed())
      }
    })
  }

  const finished = (id: string) => setProgress(({ [id]: _, ...rest }) => rest)

  const use = (e: LocalModelEntry) =>
    patch({
      provider: 'systemone',
      managed: { catalogId: e.id },
      baseUrl: 'http://127.0.0.1',
      noKey: true,
      model: e.id,
      name: draft.name || e.label,
      contextTokens: e.contextTokens,
      optionsBudgetTokens: e.optionsBudgetTokens,
      systemOneFlavor: undefined,
      maxStateTokens: undefined,
    })

  const startTest = (id: string) => {
    setServers((s) => ({ ...s, [id]: 'starting' }))
    void run(async () => {
      try {
        const info = await rt.start(id)
        setServers((s) => ({ ...s, [id]: info }))
      } catch (e) {
        setServers(({ [id]: _, ...rest }) => rest)
        throw e
      }
    })
  }

  // Leaving a managed model drops the numbers that belonged to its catalog entry.
  const selfRun = (change: Partial<LlmConfig>) =>
    patch({
      ...(draft.managed ? { baseUrl: '', model: '', contextTokens: undefined, optionsBudgetTokens: undefined } : {}),
      ...change,
      managed: undefined,
    })

  const rtBlocked = (p: RuntimePlan) => (p.includesSystemOne === false ? t(NO_RELEASE_YET) : undefined)

  return (
    <div className="llm-local llm-wide">
      <h4>{t('llm.s1.hardware')}</h4>
      <p>
        {hw
          ? `${t('llm.s1.hardwareLine', {
              ram: formatBytes(hw.totalRamBytes),
              disk: formatBytes(hw.diskFreeBytes),
              gpus: hw.gpus.length ? hw.gpus.map((g) => g.name).join(', ') : t('llm.s1.noGpu'),
            })} ${hardwareSentence(hw)}`
          : t('llm.common.checking')}
      </p>

      <h4>{t('llm.s1.runtime')}</h4>
      {runtime?.found ? (
        <p>
          {runtime.version
            ? t('llm.s1.foundRuntimeVersion', { source: runtime.source, version: runtime.version })
            : t('llm.s1.foundRuntime', { source: runtime.source })}
          {runtime.supportsSystemOne === false && ` ${t(NO_RELEASE_YET)}`}
        </p>
      ) : (
        <>
          <p>{t('llm.s1.noRuntime')}</p>
          {progress.runtime && progress.runtime.phase !== 'done' ? (
            <p>
              <Bar label={t('llm.s1.runtimeDownload')} completed={progress.runtime.completed} total={progress.runtime.total} />{' '}
              {progress.runtime.phase}{' '}
              <button type="button" onClick={() => void rt.cancel('runtime').then(() => finished('runtime'))}>
                {t('common.cancel')}
              </button>
            </p>
          ) : (
            <button type="button" onClick={() => void askRuntime()} disabled={consent !== null}>
              {t('llm.s1.reviewRuntime')}
            </button>
          )}
        </>
      )}
      {consent?.kind === 'runtime' && (
        <ConsentBox
          label={t('llm.s1.runtimeConsent')}
          confirmLabel={t('llm.local.downloadSize', { size: formatBytes(consent.plan.sizeBytes) })}
          onConfirm={confirm}
          onCancel={() => setConsent(null)}
          blockedReason={rtBlocked(consent.plan)}
        >
          {t('llm.s1.runtimeConsentBody', {
            tag: consent.plan.tag,
            asset: consent.plan.assetName,
            size: formatBytes(consent.plan.sizeBytes),
            backend: backendName(consent.plan.backend),
            source: consent.plan.source,
            destination: consent.plan.destination,
            disk: formatBytes(consent.plan.diskFreeBytes),
          })}
          {consent.plan.includesSystemOne === 'unknown' && t('llm.s1.runtimeUnconfirmed')}
        </ConsentBox>
      )}

      <h4>{t('llm.s1.models')}</h4>
      <ul className="llm-list">
        {MODELS.map((e) => {
          const isInstalled = installed.some((m) => m.catalogId === e.id)
          const prog = progress[e.id]
          const server = servers[e.id]
          return (
            <li key={e.id} className="llm-item" aria-label={e.label}>
              <div className="llm-item-main">
                <div className="llm-item-name">
                  {e.label} {isInstalled && <span className="llm-badge">{t('llm.s1.installed')}</span>}{' '}
                  {draft.managed?.catalogId === e.id && <span className="llm-badge">{t('llm.local.selected')}</span>}
                </div>
                {e.status === 'planned' ? (
                  <div className="llm-item-meta">
                    {t('llm.s1.notAvailable', { reason: e.plannedReason ?? t('llm.catalog.notAvailable') })}
                  </div>
                ) : (
                  <div className="llm-item-meta">
                    {formatBytes(e.approxBytes)} · {e.license} · {windowSentence(e.contextTokens, e.optionsBudgetTokens)}
                  </div>
                )}
                {prog && prog.phase !== 'done' && (
                  <div>
                    <Bar label={t('llm.local.downloadLabel', { label: e.label })} completed={prog.completed} total={prog.total} /> {prog.phase}{' '}
                    <button type="button" onClick={() => void rt.cancel(e.id).then(() => finished(e.id))}>
                      {t('llm.s1.cancelDownload')}
                    </button>
                  </div>
                )}
                {server === 'starting' && <div role="status">{t('llm.s1.starting')}</div>}
                {server && server !== 'starting' && (
                  <div role="status" className="llm-status-ok">
                    {server.layersOffloaded !== undefined
                      ? t('llm.s1.runningLayers', {
                          backend: backendName(server.backend),
                          device: server.usingGpu ? 'GPU' : 'CPU',
                          layers: server.layersOffloaded,
                        })
                      : t('llm.s1.running', { backend: backendName(server.backend), device: server.usingGpu ? 'GPU' : 'CPU' })}
                    {server.note ? ` ${server.note}` : ''}{' '}
                    <button type="button" onClick={() => void rt.stop(e.id).then(() => setServers(({ [e.id]: _, ...r }) => r))}>
                      {t('llm.s1.stop')}
                    </button>
                  </div>
                )}
              </div>
              {e.status === 'available' && !isInstalled && !(prog && prog.phase !== 'done') && (
                <button type="button" onClick={() => void askModel(e)} disabled={consent !== null}>
                  {t('llm.local.download')}
                </button>
              )}
              {e.status === 'available' && isInstalled && (
                <>
                  <button type="button" onClick={() => use(e)}>
                    {t('llm.s1.useModel')}
                  </button>
                  <button type="button" onClick={() => startTest(e.id)} disabled={server === 'starting'}>
                    {t('llm.s1.startTest')}
                  </button>
                  <button type="button" onClick={() => void run(async () => setInstalled(await rt.remove(e.id)))}>
                    {t('common.remove')}
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
      {consent?.kind === 'model' && (
        <ConsentBox
          label={t('llm.local.modelConsent')}
          confirmLabel={t('llm.local.downloadSize', { size: formatBytes(consent.plan.sizeBytes) })}
          onConfirm={confirm}
          onCancel={() => setConsent(null)}
        >
          {t('llm.s1.modelConsentBody', {
            size: formatBytes(consent.plan.sizeBytes),
            repo: consent.plan.repo,
            destination: consent.plan.destination,
            disk: formatBytes(consent.plan.diskFreeBytes),
            license: consent.plan.license,
          })}
        </ConsentBox>
      )}
      {error && (
        <p role="alert" className="llm-status-error">
          {error}
        </p>
      )}

      <details>
        <summary>{t('llm.s1.connectSelf')}</summary>
        <p className="llm-hint">{t('llm.s1.connectHint')}</p>
        <div className="llm-row">
          <label htmlFor="llm-s1-url" className="llm-label">
            {t('llm.chat.serverUrl')}
          </label>
          <input
            id="llm-s1-url"
            type="text"
            value={draft.managed ? '' : draft.baseUrl}
            placeholder="http://localhost:8000"
            onChange={(e) => selfRun({ baseUrl: e.target.value })}
          />
        </div>
        <div className="llm-row">
          <label htmlFor="llm-s1-model" className="llm-label">
            {t('llm.s1.modelName')}
          </label>
          <input
            id="llm-s1-model"
            type="text"
            value={draft.managed ? '' : draft.model}
            onChange={(e) => selfRun({ model: e.target.value })}
          />
        </div>
      </details>
    </div>
  )
}

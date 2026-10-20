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
import { Bar, ConsentBox, Unavailable } from './LocalBits'

export const NO_RELEASE_YET =
  'No released llama.cpp build includes the System One route yet — check again later, or connect to a server you run yourself.'

const MODELS = LOCAL_MODEL_CATALOG.filter((e) => e.kind === 'systemone')
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Consent = { kind: 'runtime'; plan: RuntimePlan } | { kind: 'model'; plan: ModelPlan; entry: LocalModelEntry }

/** Managed local System One: hardware, llama.cpp runtime, model downloads, and a self-run server fallback. */
export function LocalSystemOnePanel(props: { draft: LlmConfig; patch: (c: Partial<LlmConfig>) => void }) {
  const rt = getPlatform().localRuntime
  return rt ? <Panel rt={rt} {...props} /> : <Unavailable />
}

function Panel({ rt, draft, patch }: { rt: LocalRuntimeApi; draft: LlmConfig; patch: (c: Partial<LlmConfig>) => void }) {
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

  const rtBlocked = (p: RuntimePlan) => (p.includesSystemOne === false ? NO_RELEASE_YET : undefined)

  return (
    <div className="llm-local llm-wide">
      <h4>Your hardware</h4>
      <p>
        {hw
          ? `${formatBytes(hw.totalRamBytes)} RAM, ${formatBytes(hw.diskFreeBytes)} free disk, ${
              hw.gpus.length ? hw.gpus.map((g) => g.name).join(', ') : 'no GPU found'
            }. ${hardwareSentence(hw)}`
          : 'Checking…'}
      </p>

      <h4>Runtime (llama.cpp)</h4>
      {runtime?.found ? (
        <p>
          Found a {runtime.source} llama-server{runtime.version ? ` (${runtime.version})` : ''}.
          {runtime.supportsSystemOne === false && ` ${NO_RELEASE_YET}`}
        </p>
      ) : (
        <>
          <p>No llama-server found. The app can download llama.cpp for you.</p>
          {progress.runtime && progress.runtime.phase !== 'done' ? (
            <p>
              <Bar label="Runtime download" completed={progress.runtime.completed} total={progress.runtime.total} />{' '}
              {progress.runtime.phase}{' '}
              <button type="button" onClick={() => void rt.cancel('runtime').then(() => finished('runtime'))}>
                Cancel
              </button>
            </p>
          ) : (
            <button type="button" onClick={() => void askRuntime()} disabled={consent !== null}>
              Review runtime download…
            </button>
          )}
        </>
      )}
      {consent?.kind === 'runtime' && (
        <ConsentBox
          label="Runtime download consent"
          confirmLabel={`Download ${formatBytes(consent.plan.sizeBytes)}`}
          onConfirm={confirm}
          onCancel={() => setConsent(null)}
          blockedReason={rtBlocked(consent.plan)}
        >
          This downloads llama.cpp {consent.plan.tag} ({consent.plan.assetName}, {formatBytes(consent.plan.sizeBytes)},{' '}
          {backendName(consent.plan.backend)} build) from {consent.plan.source} to {consent.plan.destination}. License:
          MIT. Verified by SHA-256 before use. Free disk: {formatBytes(consent.plan.diskFreeBytes)}.
          {consent.plan.includesSystemOne === 'unknown' &&
            ' Whether this release has the System One route is unconfirmed; the app tests it after start.'}
        </ConsentBox>
      )}

      <h4>Models</h4>
      <ul className="llm-list">
        {MODELS.map((e) => {
          const isInstalled = installed.some((m) => m.catalogId === e.id)
          const prog = progress[e.id]
          const server = servers[e.id]
          return (
            <li key={e.id} className="llm-item" aria-label={e.label}>
              <div className="llm-item-main">
                <div className="llm-item-name">
                  {e.label} {isInstalled && <span className="llm-badge">Installed</span>}{' '}
                  {draft.managed?.catalogId === e.id && <span className="llm-badge">Selected</span>}
                </div>
                {e.status === 'planned' ? (
                  <div className="llm-item-meta">Not available yet: {e.plannedReason}</div>
                ) : (
                  <div className="llm-item-meta">
                    {formatBytes(e.approxBytes)} · {e.license} · {windowSentence(e.contextTokens, e.optionsBudgetTokens)}
                  </div>
                )}
                {prog && prog.phase !== 'done' && (
                  <div>
                    <Bar label={`${e.label} download`} completed={prog.completed} total={prog.total} /> {prog.phase}{' '}
                    <button type="button" onClick={() => void rt.cancel(e.id).then(() => finished(e.id))}>
                      Cancel download
                    </button>
                  </div>
                )}
                {server === 'starting' && <div role="status">Starting…</div>}
                {server && server !== 'starting' && (
                  <div role="status" className="llm-status-ok">
                    Running on {backendName(server.backend)} ({server.usingGpu ? 'GPU' : 'CPU'}
                    {server.layersOffloaded !== undefined ? `, ${server.layersOffloaded} layers offloaded` : ''}).
                    {server.note ? ` ${server.note}` : ''}{' '}
                    <button type="button" onClick={() => void rt.stop(e.id).then(() => setServers(({ [e.id]: _, ...r }) => r))}>
                      Stop
                    </button>
                  </div>
                )}
              </div>
              {e.status === 'available' && !isInstalled && !(prog && prog.phase !== 'done') && (
                <button type="button" onClick={() => void askModel(e)} disabled={consent !== null}>
                  Download
                </button>
              )}
              {e.status === 'available' && isInstalled && (
                <>
                  <button type="button" onClick={() => use(e)}>
                    Use this model
                  </button>
                  <button type="button" onClick={() => startTest(e.id)} disabled={server === 'starting'}>
                    Start &amp; test
                  </button>
                  <button type="button" onClick={() => void run(async () => setInstalled(await rt.remove(e.id)))}>
                    Remove
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
      {consent?.kind === 'model' && (
        <ConsentBox
          label="Model download consent"
          confirmLabel={`Download ${formatBytes(consent.plan.sizeBytes)}`}
          onConfirm={confirm}
          onCancel={() => setConsent(null)}
        >
          This downloads a {formatBytes(consent.plan.sizeBytes)} model file from huggingface.co ({consent.plan.repo}) to{' '}
          {consent.plan.destination}. Free disk: {formatBytes(consent.plan.diskFreeBytes)}. Verified by SHA-256 before
          use. License: {consent.plan.license}.
        </ConsentBox>
      )}
      {error && (
        <p role="alert" className="llm-status-error">
          {error}
        </p>
      )}

      <details>
        <summary>Connect to a server you run yourself</summary>
        <p className="llm-hint">
          For example laya-serve on http://localhost:8000, or your own llama-server. Needs no download.
        </p>
        <div className="llm-row">
          <label htmlFor="llm-s1-url" className="llm-label">
            Server URL
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
            Model name
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

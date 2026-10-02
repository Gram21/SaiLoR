import { useEffect, useRef, useState } from 'react'
import { getPlatform } from '../platform'
import {
  gpuStatus,
  OLLAMA_SHORTLIST,
  type LocalServerKind,
  type LocalServerModel,
  type OllamaModel,
  type PullProgress,
  type ShortlistModel,
} from '../llm/ollama'
import { formatBytes, gpuText, hostOf, memoryCheck, suggestContext } from '../llm/localUi'
import type { LlmConfig } from '../llm/types'
import type { HardwareInfo } from '../platform/localRuntime'
import { Bar, ConsentBox, Unavailable } from './LocalBits'

const SERVER_TYPES: { id: string; label: string; url: string }[] = [
  { id: 'ollama', label: 'Ollama', url: 'http://localhost:11434' },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234' },
  { id: 'llamacpp', label: 'llama.cpp', url: 'http://localhost:8080' },
  { id: 'vllm', label: 'vLLM', url: 'http://localhost:8000' },
  { id: 'other', label: 'Other (OpenAI-compatible)', url: '' },
]

interface Checked {
  kind: LocalServerKind
  isLocal: boolean
  models: LocalServerModel[]
  version?: string
  /** Ollama only: installed models with size, parameters and quantization. */
  installed: OllamaModel[]
  /** Ollama only: where each loaded model runs. */
  running: Record<string, string>
}

interface Picked {
  id: string
  weightsBytes: number
  modelMax?: number
}

interface Pull {
  tag: string
  p?: PullProgress
  error?: string
}

const typeOfUrl = (url: string) => SERVER_TYPES.find((t) => t.url && t.url === url.replace(/\/+$/, ''))?.id ?? 'other'

/** Chat models on a server the user runs: Ollama (native API) and OpenAI-compatible servers. */
export function LocalChatPanel(props: { draft: LlmConfig; patch: (c: Partial<LlmConfig>) => void }) {
  return getPlatform().discoverLocalServer ? <Panel {...props} /> : <Unavailable />
}

function Panel({ draft, patch }: { draft: LlmConfig; patch: (c: Partial<LlmConfig>) => void }) {
  const platform = getPlatform()
  const [type, setType] = useState(draft.provider === 'ollama' ? 'ollama' : typeOfUrl(draft.baseUrl))
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [hw, setHw] = useState<HardwareInfo | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [kvBytes, setKvBytes] = useState<number | null>(null)
  const [consent, setConsent] = useState<{ model: ShortlistModel; bytes: number } | null>(null)
  const [pull, setPull] = useState<Pull | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    platform.localRuntime?.probe().then(setHw, () => {})
  }, [platform])

  // KV cache grows with the window: re-ask Ollama whenever the chosen window changes.
  useEffect(() => {
    if (checked?.kind !== 'ollama' || !picked) return
    let live = true
    void platform.ollama?.show(draft.baseUrl, picked.id, draft.contextTokens).then((r) => {
      if (live && r.ok) setKvBytes(r.info.kvBytes)
    })
    return () => {
      live = false
    }
  }, [checked?.kind, picked, draft.baseUrl, draft.contextTokens, platform])

  const ollama = platform.ollama
  const isOllama = checked?.kind === 'ollama'

  const changeType = (id: string) => {
    setType(id)
    setChecked(null)
    setPicked(null)
    const url = SERVER_TYPES.find((t) => t.id === id)?.url
    if (url) patch({ baseUrl: url })
  }

  const check = async () => {
    setChecking(true)
    setError(null)
    setChecked(null)
    try {
      const r = await platform.discoverLocalServer!(draft.baseUrl.trim())
      if (!r.ok) return setError(r.error)
      const next: Checked = { kind: r.kind, isLocal: r.isLocal, models: r.models, installed: [], running: {} }
      if (r.kind === 'ollama' && ollama) {
        const url = draft.baseUrl.trim()
        const [v, l, ps] = await Promise.all([ollama.version(url), ollama.list(url), ollama.ps(url)])
        if (v.ok) next.version = v.version
        if (l.ok) next.installed = l.models
        if (ps.ok) for (const m of ps.running) { const g = gpuStatus(m); next.running[m.name] = gpuText(g.kind, g.pct) }
      }
      setChecked(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  const choose = async (id: string, weightsBytes: number, listedMax?: number) => {
    let modelMax = listedMax
    if (isOllama && ollama) {
      const r = await ollama.show(draft.baseUrl, id)
      if (r.ok) modelMax = r.info.contextTokens ?? modelMax
    }
    setKvBytes(null)
    setPicked({ id, weightsBytes, modelMax })
    patch({
      provider: isOllama ? 'ollama' : 'openai-compatible',
      model: id,
      noKey: true,
      contextTokens: suggestContext(hw?.totalRamBytes, modelMax),
      name: draft.name || id,
    })
  }

  const ask = async (model: ShortlistModel) => {
    setError(null)
    const r = await ollama!.manifestSize(model.tag)
    if (!r.ok) return setError(r.error)
    if (r.bytes === null) return setError(`"${model.tag}" was not found in the Ollama registry (404) — the tag may have been renamed.`)
    setConsent({ model, bytes: r.bytes })
  }

  const download = async () => {
    if (!consent) return
    const tag = consent.model.tag
    setConsent(null)
    abort.current = new AbortController()
    setPull({ tag })
    const r = await ollama!.pull(draft.baseUrl, tag, (p) => {
      setPull((s) => (s && s.tag === tag ? { ...s, p, error: p.error ?? s.error } : s))
    }, abort.current.signal)
    if (!r.ok) return setPull({ tag, error: r.error })
    setPull(null)
    void check()
  }

  const remove = async (name: string) => {
    if (deleting !== name) return setDeleting(name)
    setDeleting(null)
    const r = await ollama!.delete(draft.baseUrl, name)
    if (!r.ok) setError(r.error)
    else void check()
  }

  const mem = picked ? memoryCheck(picked.weightsBytes, kvBytes, hw) : null
  const maxCtx = picked?.modelMax
  const fits = (m: ShortlistModel) => hw !== null && hw.totalRamBytes >= m.minRamGB * 1e9

  return (
    <div className="llm-local llm-wide">
      <div className="llm-row">
        <label htmlFor="llm-chat-type" className="llm-label">
          Server type
        </label>
        <select id="llm-chat-type" value={type} onChange={(e) => changeType(e.target.value)}>
          {SERVER_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="llm-row">
        <label htmlFor="llm-chat-url" className="llm-label">
          Server URL
        </label>
        <div className="llm-model-field">
          <input
            id="llm-chat-url"
            type="text"
            value={draft.baseUrl}
            placeholder="http://localhost:1234"
            onChange={(e) => {
              patch({ baseUrl: e.target.value })
              setChecked(null)
            }}
          />
          <button type="button" onClick={() => void check()} disabled={checking || !draft.baseUrl.trim()}>
            {checking ? 'Checking…' : 'Check connection'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="llm-status-error">
          {error}
        </p>
      )}

      {checked && (
        <>
          <p role="status" className="llm-status-ok">
            Connected to {checked.kind === 'unknown' ? 'an OpenAI-compatible server' : SERVER_TYPES.find((t) => t.id === checked.kind)?.label ?? checked.kind}
            {checked.version ? ` ${checked.version}` : ''}.
          </p>
          {!checked.isLocal && (
            <p role="alert" className="llm-warning">
              Papers will be sent over the network to {hostOf(draft.baseUrl)}.
            </p>
          )}
          <h4>{isOllama ? 'Installed models' : 'Models on this server'}</h4>
          {isOllama && (
            <p className="llm-hint llm-wide">
              Where a model runs (GPU or CPU) shows once it is loaded, e.g. after Verify setup — press Check connection again.
            </p>
          )}
          {isOllama ? (
            <ul className="llm-list">
              {checked.installed.map((m) => (
                <li key={m.name} className="llm-item" aria-label={m.name}>
                  <div className="llm-item-main">
                    <div className="llm-item-name">{m.name}</div>
                    <div className="llm-item-meta">
                      {[formatBytes(m.sizeBytes), m.parameterSize, m.quantization].filter(Boolean).join(' · ')}
                      {checked.running[m.name] ? ` · loaded: ${checked.running[m.name]}` : ''}
                    </div>
                  </div>
                  <button type="button" onClick={() => void choose(m.name, m.sizeBytes)}>
                    {draft.model === m.name ? 'Selected' : 'Use'}
                  </button>
                  <button type="button" className={deleting === m.name ? 'llm-danger' : undefined} onClick={() => void remove(m.name)}>
                    {deleting === m.name ? 'Sure?' : 'Delete'}
                  </button>
                </li>
              ))}
              {checked.installed.length === 0 && <li className="llm-empty">No models installed yet — download one below.</li>}
            </ul>
          ) : (
            <ul className="llm-list">
              {checked.models.map((m) => (
                <li key={m.id} className="llm-item" aria-label={m.id}>
                  <div className="llm-item-main">
                    <div className="llm-item-name">{m.id}</div>
                    <div className="llm-item-meta">
                      {m.contextTokens ? `context ${m.contextTokens.toLocaleString('en-US')} tokens` : 'context unknown'}
                      {m.loaded !== undefined ? ` · ${m.loaded ? 'loaded' : 'not loaded'}` : ''}
                    </div>
                  </div>
                  <button type="button" onClick={() => void choose(m.id, m.sizeBytes ?? 0, m.contextTokens)}>
                    {draft.model === m.id ? 'Selected' : 'Use'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {picked && (
        <>
          <div className="llm-row">
            <label htmlFor="llm-context" className="llm-label">
              Context to use
            </label>
            <input
              id="llm-context"
              type="number"
              min="1"
              step="1"
              max={maxCtx}
              value={draft.contextTokens ?? ''}
              onChange={(e) => patch({ contextTokens: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </div>
          <p className="llm-hint">
            Long papers need a large context; the server's default is often only 4,096 tokens, which would silently cut the
            paper. The app sets it explicitly. Larger = more memory.
            {maxCtx ? ` This model supports up to ${maxCtx.toLocaleString('en-US')}.` : ''}
          </p>
          {mem && mem.needBytes > 0 && (
            <p role={mem.tooBig ? 'alert' : 'status'} className={mem.tooBig ? 'llm-status-error' : 'llm-hint llm-wide'}>
              Estimated memory: {formatBytes(mem.needBytes)} (model{kvBytes !== null ? ' + context' : ''}).
              {mem.tooBig && ' This exceeds your free memory: part of the model will run on the CPU: slow. Lower the context or pick a smaller model.'}
            </p>
          )}
        </>
      )}

      {isOllama && ollama && (
        <>
          <h4>Download a model</h4>
          <p className="llm-hint llm-wide">
            Models are not benchmarked for annotation quality — start with a small one and check the results.
          </p>
          <ul className="llm-list">
            {OLLAMA_SHORTLIST.map((m) => (
              <li key={m.tag} className="llm-item" aria-label={m.label}>
                <div className="llm-item-main">
                  <div className="llm-item-name">
                    {m.label} {fits(m) && <span className="llm-badge">Fits your hardware</span>}
                  </div>
                  <div className="llm-item-meta">
                    ≈{formatBytes(m.approxBytes)} · up to {m.contextTokens.toLocaleString('en-US')} tokens · about {m.minRamGB} GB RAM · {m.notes}
                  </div>
                  {pull?.tag === m.tag && (
                    <div>
                      {pull.error ? (
                        <span role="alert" className="llm-status-error">
                          Download failed: {pull.error}
                        </span>
                      ) : (
                        <>
                          <Bar label={`${m.label} download`} completed={pull.p?.completed ?? 0} total={pull.p?.total ?? 0} /> {pull.p?.status ?? 'starting'}{' '}
                          <button type="button" onClick={() => { abort.current?.abort(); setPull(null) }}>
                            Stop watching
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => void ask(m)} disabled={consent !== null || (pull !== null && !pull.error)}>
                  Download
                </button>
              </li>
            ))}
          </ul>
          {consent && (
            <ConsentBox
              label="Model download consent"
              confirmLabel={`Download ${formatBytes(consent.bytes)}`}
              onConfirm={() => void download()}
              onCancel={() => setConsent(null)}
            >
              This downloads ≈{formatBytes(consent.bytes)} into Ollama's model folder on {hostOf(draft.baseUrl)}; Ollama picks GPU
              (CUDA/Metal/ROCm/Vulkan) automatically and falls back to CPU; you can stop watching the download but Ollama may
              keep downloading in the background.
            </ConsentBox>
          )}
        </>
      )}
    </div>
  )
}

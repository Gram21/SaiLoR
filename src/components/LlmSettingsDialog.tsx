import { useEffect, useState } from 'react'
import { useAiStore } from '../state/aiStore'
import { getPlatform } from '../platform'
import { PROVIDER_LIST, PROVIDERS } from '../llm/providers'
import type { Attach, LlmConfig, ModelInfo, Provider } from '../llm/types'
import { ModelPicker } from './ModelPicker'
import '../styles/ai.css'

const NO_MODELS: ModelInfo[] = []

/**
 * Manage the LLM targets the AI-annotation feature can call.
 *
 * Two things shape this dialog:
 *  - **The renderer never holds an API key.** `LlmConfig` has no `apiKey` field, so
 *    an existing key can only ever be reported as `hasKey` — never shown, never
 *    pre-filled. Leaving the key box blank on an edit therefore *keeps* the stored
 *    key; that is the only way to edit a target without retyping the key.
 *  - **Verify has to save.** The key must be in the store before a request can use
 *    it, so "Verify setup" writes the target first. The button says so.
 *
 * It stacks on top of the AI dialog, which sits at the shared `.modal-overlay`
 * z-index of 200; `.llm-settings-overlay` in ai.css lifts it above that.
 */

/**
 * A human-readable list of the providers that can take a PDF, derived from
 * `PROVIDER_LIST` rather than hand-written — a hardcoded sentence here already
 * went stale once (Google shipped, the text didn't), so it now can't again.
 */
const pdfCapableProviders = (() => {
  const names = PROVIDER_LIST.filter((p) => p.supportsPdf).map((p) => p.label)
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
})()

/** A blank target, ready to be filled in. */
function newDraft(): LlmConfig {
  const provider = PROVIDER_LIST[0]
  return {
    id: crypto.randomUUID(),
    name: '',
    provider: provider.id,
    baseUrl: provider.defaultBaseUrl,
    model: '',
    attach: 'text',
    hasKey: false,
  }
}

export function LlmSettingsDialog() {
  const settingsOpen = useAiStore((s) => s.settingsOpen)
  const configs = useAiStore((s) => s.configs)
  const setSettingsOpen = useAiStore((s) => s.setSettingsOpen)
  const refreshConfigs = useAiStore((s) => s.refreshConfigs)
  const saveConfig = useAiStore((s) => s.saveConfig)
  const deleteConfig = useAiStore((s) => s.deleteConfig)
  const verifyConfig = useAiStore((s) => s.verifyConfig)
  const fetchModels = useAiStore((s) => s.fetchModels)
  const clearModels = useAiStore((s) => s.clearModels)
  const modelsById = useAiStore((s) => s.models)
  const modelsLoadingById = useAiStore((s) => s.modelsLoading)
  const modelsErrorById = useAiStore((s) => s.modelsError)

  /** The target being edited/added; null means we are showing the list. */
  const [draft, setDraft] = useState<LlmConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The target whose Delete button is waiting for its second click. */
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const browser = getPlatform().kind === 'browser'

  useEffect(() => {
    if (!settingsOpen) return
    void refreshConfigs()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settingsOpen, refreshConfigs, setSettingsOpen])

  // Everything local is per-visit: a stale draft or a half-armed Delete must not
  // survive a close/reopen.
  useEffect(() => {
    if (settingsOpen) return
    setDraft(null)
    setApiKey('')
    setProblem(null)
    setReply(null)
    setVerifyError(null)
    setVerifying(false)
    setConfirmId(null)
  }, [settingsOpen])

  // An armed Delete disarms itself, so a forgotten click cannot bite later.
  useEffect(() => {
    if (!confirmId) return
    const t = setTimeout(() => setConfirmId(null), 5000)
    return () => clearTimeout(t)
  }, [confirmId])

  const patch = (change: Partial<LlmConfig>) =>
    setDraft((d) => (d ? { ...d, ...change } : d))

  // Editing a target that already has a key: fetch its models once, with no
  // extra click — the key needed to do that is already stored. A brand-new
  // target has no key yet, so it waits for "Load models" (or Verify/Save,
  // both of which store one) instead of failing silently on open.
  useEffect(() => {
    if (!draft?.hasKey) return
    if (!PROVIDERS[draft.provider].supportsModelListing) return
    if (modelsById[draft.id] || modelsLoadingById[draft.id]) return
    void fetchModels(draft)
    // Only the identity of the target being edited should re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.hasKey, draft?.provider])

  // Keep the reasoning-effort value in step with the selected model: default
  // it in the moment a reasoning-capable model is picked, and drop it the
  // moment a non-reasoning one is — a stale effort level must never outlive
  // the model it was chosen for.
  useEffect(() => {
    if (!draft) return
    const models = modelsById[draft.id] ?? NO_MODELS
    const model = models.find((m) => m.id === draft.model)
    if (model?.reasoning) {
      if (!draft.reasoningEffort || !model.reasoning.levels.includes(draft.reasoningEffort)) {
        patch({ reasoningEffort: model.reasoning.defaultLevel })
      }
    } else if (draft.reasoningEffort !== undefined) {
      patch({ reasoningEffort: undefined })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.model, modelsById])

  if (!settingsOpen) return null

  const close = () => setSettingsOpen(false)

  const info = draft ? PROVIDERS[draft.provider] : null
  const urlEditable = info?.editableBaseUrl ?? false
  const modelListingSupported = info?.supportsModelListing ?? false
  const providerModels = draft ? (modelsById[draft.id] ?? NO_MODELS) : NO_MODELS
  const modelsLoading = draft ? Boolean(modelsLoadingById[draft.id]) : false
  const modelsError = draft ? (modelsErrorById[draft.id] ?? null) : null
  const selectedModel = draft ? providerModels.find((m) => m.id === draft.model) ?? null : null

  const startAdd = () => {
    setDraft(newDraft())
    setApiKey('')
    setProblem(null)
    setReply(null)
    setVerifyError(null)
  }

  const startEdit = (config: LlmConfig) => {
    setDraft({ ...config })
    setApiKey('')
    setProblem(null)
    setReply(null)
    setVerifyError(null)
  }

  const backToList = () => {
    setDraft(null)
    setApiKey('')
    setProblem(null)
    setReply(null)
    setVerifyError(null)
  }

  const changeProvider = (id: Provider) => {
    const next = PROVIDERS[id]
    setDraft((d) =>
      d
        ? {
            ...d,
            provider: id,
            // The base URL is a property of the provider unless it is editable,
            // so switching provider must not leave the old vendor's URL behind.
            baseUrl: next.editableBaseUrl ? (next.defaultBaseUrl || '') : next.defaultBaseUrl,
            attach: next.supportsPdf ? d.attach : 'text',
            // A model name (and any reasoning effort chosen for it) belongs to
            // the old provider's catalog, not the new one.
            model: '',
            reasoningEffort: undefined,
          }
        : d,
    )
    // Ditto for the fetched list itself: it answered "what does the old
    // provider have", which is not a question about the new one.
    if (draft) clearModels(draft.id)
    setReply(null)
    setVerifyError(null)
  }

  /** What is missing before this target can be saved or verified. */
  const validate = (d: LlmConfig): string | null => {
    if (!d.name.trim()) return 'Give the target a name — it is what you pick from later.'
    if (!d.model.trim()) return 'Enter a model name, e.g. claude-opus-4-8 or gpt-4o.'
    if (PROVIDERS[d.provider].editableBaseUrl && !d.baseUrl.trim()) {
      return 'Enter the base URL of your OpenAI-compatible server, e.g. http://localhost:1234.'
    }
    // A stored key is invisible here, so "blank" only means "missing" when none is stored.
    if (!d.hasKey && !apiKey.trim()) return 'Enter the API key for this provider.'
    return null
  }

  /** The draft as it would be stored: trimmed, so a stray space cannot break a URL. */
  const cleaned = (d: LlmConfig): LlmConfig => ({
    ...d,
    name: d.name.trim(),
    model: d.model.trim(),
    baseUrl: d.baseUrl.trim(),
  })

  const onSave = async () => {
    if (!draft) return
    const bad = validate(draft)
    setProblem(bad)
    if (bad) return
    setBusy(true)
    try {
      await saveConfig(cleaned(draft), apiKey.trim() || undefined)
      backToList()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onVerify = async () => {
    if (!draft) return
    const bad = validate(draft)
    setProblem(bad)
    if (bad) return
    setReply(null)
    setVerifyError(null)
    setVerifying(true)
    const key = apiKey.trim()
    try {
      const answer = await verifyConfig(cleaned(draft), key || undefined)
      setReply(answer)
      // The key is stored now (verifyConfig saves before it calls), so the box
      // must go back to "stored" — the renderer cannot show it again anyway.
      if (key) {
        setDraft((d) => (d ? { ...d, hasKey: true } : d))
        setApiKey('')
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err))
    } finally {
      setVerifying(false)
    }
  }

  const onDelete = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id)
      return
    }
    setConfirmId(null)
    setBusy(true)
    try {
      await deleteConfig(id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay llm-settings-overlay" onClick={close}>
      <div
        className="modal llm-settings"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="llm-settings-title"
      >
        <div className="modal-head">
          <strong id="llm-settings-title">
            AI targets{draft ? (configs.some((c) => c.id === draft.id) ? ' — Edit' : ' — Add') : ''}
          </strong>
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Where the key ends up is the user's business, and the honest answer
              differs per runtime. Never hide this behind a "learn more". */}
          {browser ? (
            <div className="llm-warning" role="note">
              <strong>Running in the browser — your API key is not protected here.</strong>
              <p>
                The key is saved <strong>unencrypted in this browser's local storage</strong>, where
                any script on this page — and anyone with access to this machine's browser profile —
                can read it. On top of that, some providers refuse requests made directly from a web
                page, and a self-hosted OpenAI-compatible endpoint usually will (it has no CORS
                headers for this origin). <strong>The desktop app is the supported path</strong> for
                AI annotation; use a throwaway or tightly scoped key if you continue here.
              </p>
            </div>
          ) : (
            <div className="llm-notice" role="note">
              The API key is stored <strong>encrypted with your operating system's keychain</strong>
              , is held by the app's main process, and is never handed to the page that renders this
              dialog. It is spliced into a request only as it is sent to the provider.
            </div>
          )}

          {!draft ? (
            <>
              {configs.length === 0 ? (
                <p className="llm-empty">
                  No targets yet. Add one — a target is a provider, a model, and the key to reach it.
                </p>
              ) : (
                <ul className="llm-list">
                  {configs.map((config) => (
                    <li key={config.id} className="llm-item">
                      <div className="llm-item-main">
                        <div className="llm-item-name">{config.name}</div>
                        <div className="llm-item-meta">
                          {PROVIDERS[config.provider].label} · {config.model} ·{' '}
                          {config.attach === 'pdf' ? 'sends the PDF' : 'sends extracted text'}
                        </div>
                        {!config.hasKey && (
                          <div className="llm-nokey">
                            No API key stored — this target cannot be used until you add one.
                          </div>
                        )}
                      </div>
                      <button type="button" onClick={() => startEdit(config)} disabled={busy}>
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(config.id)}
                        disabled={busy}
                        title={
                          confirmId === config.id
                            ? `Click again to delete "${config.name}"`
                            : `Delete "${config.name}"`
                        }
                        className={confirmId === config.id ? 'llm-danger' : undefined}
                      >
                        {confirmId === config.id ? 'Sure?' : 'Delete'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="llm-add">
                <button type="button" className="primary" onClick={startAdd} disabled={busy}>
                  + Add target
                </button>
              </div>
            </>
          ) : (
            <form
              className="llm-form"
              onSubmit={(e) => {
                e.preventDefault()
                void onSave()
              }}
            >
              <div className="llm-row">
                <label htmlFor="llm-name" className="llm-label">
                  Name
                </label>
                <input
                  id="llm-name"
                  type="text"
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="e.g. Claude (work key)"
                  required
                />
              </div>
              <p className="llm-hint">Shown in the picker when you start an AI annotation.</p>

              <div className="llm-row">
                <label htmlFor="llm-provider" className="llm-label">
                  Provider
                </label>
                <select
                  id="llm-provider"
                  value={draft.provider}
                  onChange={(e) => changeProvider(e.target.value as Provider)}
                >
                  {PROVIDER_LIST.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="llm-row">
                <label htmlFor="llm-url" className="llm-label">
                  Base URL
                </label>
                <input
                  id="llm-url"
                  type="text"
                  value={draft.baseUrl}
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                  readOnly={!urlEditable}
                  required={urlEditable}
                  placeholder={urlEditable ? 'http://localhost:1234' : ''}
                  title={
                    urlEditable
                      ? 'The root of your OpenAI-compatible server, e.g. http://localhost:1234'
                      : `Fixed for ${info?.label ?? 'this provider'}.`
                  }
                />
              </div>
              <p className="llm-hint">
                {urlEditable
                  ? 'Where your server listens — e.g. LM Studio, llama.cpp or vLLM on http://localhost:1234.'
                  : 'Fixed for this provider, so there is nothing to type.'}
              </p>

              <div className="llm-row">
                <label htmlFor="llm-model" className="llm-label">
                  Model
                </label>
                <div className="llm-model-field">
                  <ModelPicker
                    id="llm-model"
                    value={draft.model}
                    onChange={(v) => patch({ model: v })}
                    models={modelListingSupported ? providerModels : NO_MODELS}
                    loading={modelListingSupported && modelsLoading}
                    providerLabel={info?.label ?? 'This provider'}
                    placeholder="e.g. claude-opus-4-8, gpt-4o"
                  />
                  {modelListingSupported && (
                    <button
                      type="button"
                      onClick={() => void fetchModels(draft, apiKey.trim() || undefined, { force: true })}
                      disabled={modelsLoading || (!draft.hasKey && !apiKey.trim())}
                      title={
                        !draft.hasKey && !apiKey.trim()
                          ? 'Enter an API key first — the list has to be fetched with it.'
                          : `Fetch the current model list from ${info?.label ?? 'the provider'}.`
                      }
                    >
                      {modelsLoading ? 'Loading…' : providerModels.length > 0 ? 'Refresh' : 'Load models'}
                    </button>
                  )}
                </div>
              </div>
              <p className="llm-hint">
                {!modelListingSupported
                  ? "OpenAI-compatible servers vary too much for the app to reliably list or validate models — type the model name your server expects. Nothing here is checked; that's on you to get right."
                  : providerModels.length > 0
                    ? `${providerModels.length} model${providerModels.length === 1 ? '' : 's'} loaded from ${info?.label ?? 'the provider'} — search the list, or type a name it doesn't have.`
                    : "Type the model name exactly as the provider documents it, or load the current list once a key is set (a red field means the typed name isn't in a loaded list)."}
              </p>
              {modelListingSupported && modelsError && (
                <p role="alert" className="llm-problem">
                  Couldn't load the model list: {modelsError}
                </p>
              )}

              {selectedModel?.reasoning && (
                <div className="llm-row">
                  <label htmlFor="llm-effort" className="llm-label">
                    Reasoning effort
                  </label>
                  <select
                    id="llm-effort"
                    value={draft.reasoningEffort ?? selectedModel.reasoning.defaultLevel}
                    onChange={(e) => patch({ reasoningEffort: e.target.value })}
                  >
                    {selectedModel.reasoning.levels.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {lvl}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selectedModel?.reasoning && (
                <p className="llm-hint">
                  How hard this model thinks before answering. Higher effort tends to be slower and
                  more expensive; "medium" is a reasonable default.
                </p>
              )}

              <div className="llm-row">
                <label htmlFor="llm-key" className="llm-label">
                  API key
                </label>
                <input
                  id="llm-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    draft.hasKey ? 'Key stored — leave blank to keep it' : 'Paste the provider key'
                  }
                  required={!draft.hasKey}
                />
              </div>
              <p className="llm-hint">
                A stored key is never shown again, not even here — this dialog can only ever be told{' '}
                <em>that</em> one exists. Type a new key to replace it.
              </p>

              <div className="llm-row">
                <label htmlFor="llm-attach" className="llm-label">
                  Send the paper as
                </label>
                <select
                  id="llm-attach"
                  value={draft.attach}
                  onChange={(e) => patch({ attach: e.target.value as Attach })}
                >
                  <option value="text">Extracted text (recommended)</option>
                  <option
                    value="pdf"
                    disabled={!info?.supportsPdf}
                    title={
                      info?.supportsPdf
                        ? 'The provider receives the PDF file itself.'
                        : 'This provider cannot take a PDF.'
                    }
                  >
                    The PDF itself{info?.supportsPdf ? '' : ' — not supported by this provider'}
                  </option>
                </select>
              </div>
              <p className="llm-hint">
                {info?.supportsPdf
                  ? 'Extracted text is smaller, cheaper and works everywhere; the PDF keeps tables and figures intact but costs far more. Scanned papers yield no text, so only the PDF path can read them.'
                  : `This provider has no way to take a PDF in a single request — either it has no file input at all, or it needs the file uploaded and referenced separately, which this app does not do. So this target must send extracted text. ${pdfCapableProviders} can take the PDF.`}
              </p>

              {problem && (
                <p role="alert" className="llm-problem">
                  {problem}
                </p>
              )}

              <div className="llm-verify">
                <div className="llm-verify-row">
                  <button type="button" onClick={() => void onVerify()} disabled={verifying || busy}>
                    {verifying ? 'Checking…' : 'Verify setup'}
                  </button>
                  <span className="llm-verify-hint">
                    Sends a one-word test request. <strong>This saves the target first</strong> —
                    the key has to be stored before anything can use it.
                  </span>
                </div>
                {verifying && (
                  <p role="status" className="llm-status">
                    Checking… waiting for {info?.label ?? 'the provider'} to answer.
                  </p>
                )}
                {reply !== null && !verifying && (
                  <p role="status" className="llm-status-ok">
                    Works. {info?.label ?? 'The provider'} answered: “{reply}”
                  </p>
                )}
                {verifyError && !verifying && (
                  <p role="alert" className="llm-status-error">
                    {verifyError}
                  </p>
                )}
              </div>

              <div className="llm-actions">
                <button type="button" onClick={backToList} disabled={busy || verifying}>
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={busy || verifying}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

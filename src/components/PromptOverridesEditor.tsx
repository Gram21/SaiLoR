// [impl->req~llm-794~1]
import { useEditorStore, type EditorNode } from '../state/editorStore'
import { DEFAULT_ROLE } from '../llm/prompt'
import { cleanPromptOverrides, PROMPT_OVERRIDE_LIMITS } from '../model/promptOverrides'
import { useT } from '../i18n'

function fieldPaths(nodes: EditorNode[], prefix = ''): { path: string; description: string }[] {
  return nodes.flatMap((n) => {
    const path = prefix ? `${prefix}/${n.name}` : n.name
    return n.name.trim() ? [{ path, description: n.description.trim() }, ...fieldPaths(n.children, path)] : []
  })
}

export function PromptOverridesEditor() {
  const t = useT()
  const overrides = useEditorStore((s) => s.promptOverrides)
  const setPromptOverrides = useEditorStore((s) => s.setPromptOverrides)
  const nodes = useEditorStore((s) => s.nodes)
  const screening = useEditorStore((s) => s.screening)
  const busy = useEditorStore((s) => s.busy)

  const help = overrides.fieldHelp ?? {}
  const fields = screening ? [] : fieldPaths(nodes)
  const known = new Set(fields.map((f) => f.path))
  const orphans = Object.keys(help).filter((p) => !known.has(p))
  const setHelp = (path: string, value: string | null, coalesce = true) => {
    const next = { ...help }
    if (value === null) delete next[path]
    else next[path] = value
    setPromptOverrides({ fieldHelp: next }, coalesce)
  }

  return (
    <section className="editor-section prompt-overrides-editor">
      <details className="editor-protocol-details" open={cleanPromptOverrides(overrides) !== undefined}>
        <summary>
          <h2>{t('editor.prompt.title')}</h2>
          <span className="editor-protocol-summary-hint">
            {cleanPromptOverrides(overrides) ? t('editor.prompt.active') : t('editor.project.optional')}
          </span>
        </summary>
        <p className="editor-hint">{t('editor.prompt.hint')}</p>

        <label className="protocol-field">
          <span className="protocol-field-label">{t('editor.prompt.role')}</span>
          <textarea
            className="protocol-textarea"
            rows={2}
            maxLength={PROMPT_OVERRIDE_LIMITS.role}
            value={overrides.role ?? ''}
            placeholder={DEFAULT_ROLE}
            disabled={busy}
            onChange={(e) => setPromptOverrides({ role: e.target.value })}
          />
        </label>
        <p className="editor-hint">
          {t('editor.prompt.default')} <q>{DEFAULT_ROLE}</q>
        </p>
        <button
          type="button"
          disabled={busy || !overrides.role}
          onClick={() => setPromptOverrides({ role: '' }, false)}
        >
          {t('editor.prompt.reset')}
        </button>

        <label className="protocol-field">
          <span className="protocol-field-label">{t('editor.prompt.examples')}</span>
          <textarea
            className="protocol-textarea"
            rows={4}
            maxLength={PROMPT_OVERRIDE_LIMITS.examples}
            value={overrides.examples ?? ''}
            placeholder={t('editor.prompt.examplesPlaceholder')}
            disabled={busy}
            onChange={(e) => setPromptOverrides({ examples: e.target.value })}
          />
        </label>
        <button
          type="button"
          disabled={busy || !overrides.examples}
          onClick={() => setPromptOverrides({ examples: '' }, false)}
        >
          {t('editor.prompt.reset')}
        </button>

        {(fields.length > 0 || orphans.length > 0) && (
          <>
            <h3>{t('editor.prompt.fieldHelp')}</h3>
            <p className="editor-hint">{t('editor.prompt.fieldHelpHint')}</p>
          </>
        )}
        {fields.map((f) => (
          <div key={f.path} className="protocol-field">
            <label className="protocol-field-label" htmlFor={`prompt-help-${f.path}`}>
              <code>{f.path}</code>
            </label>
            <textarea
              id={`prompt-help-${f.path}`}
              className="protocol-textarea"
              rows={2}
              maxLength={PROMPT_OVERRIDE_LIMITS.fieldHelp}
              value={help[f.path] ?? ''}
              placeholder={f.description || t('editor.prompt.noDefault')}
              disabled={busy}
              onChange={(e) => setHelp(f.path, e.target.value)}
            />
            <button
              type="button"
              disabled={busy || help[f.path] === undefined}
              onClick={() => setHelp(f.path, null, false)}
            >
              {t('editor.prompt.reset')}
            </button>
          </div>
        ))}
        {orphans.map((path) => (
          <p key={path} className="editor-field-problem">
            {t('editor.prompt.orphan', { path })}{' '}
            <button type="button" disabled={busy} onClick={() => setHelp(path, null, false)}>
              {t('editor.prompt.remove')}
            </button>
          </p>
        ))}
      </details>
    </section>
  )
}

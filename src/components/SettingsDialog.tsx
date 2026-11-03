import { useEffect, useRef, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { useGitStore } from '../state/gitStore'
import type { Theme } from '../state/settings'

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function GeneralSection() {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const fontScale = useStore((s) => s.fontScale)
  const increaseFont = useStore((s) => s.increaseFont)
  const decreaseFont = useStore((s) => s.decreaseFont)
  const resetFont = useStore((s) => s.resetFont)
  const autosaveEnabled = useStore((s) => s.autosaveEnabled)
  const setAutosaveEnabled = useStore((s) => s.setAutosaveEnabled)
  return (
    <>
      <label className="settings-row">
        <span>Theme</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <div className="settings-row" role="group" aria-labelledby="settings-font-label">
        <span id="settings-font-label">Font size</span>
        <span className="font-controls">
          <button type="button" className="icon-btn" title="Decrease app font size" aria-label="Decrease font size" onClick={decreaseFont}>
            A−
          </button>
          <output aria-live="polite">{Math.round(fontScale * 100)}%</output>
          <button type="button" className="icon-btn" title="Increase app font size" aria-label="Increase font size" onClick={increaseFont}>
            A+
          </button>
          <button type="button" className="icon-btn" title="Reset app font size to 100%" onClick={resetFont}>
            Reset
          </button>
        </span>
      </div>
      <label className="settings-row">
        <input type="checkbox" checked={autosaveEnabled} onChange={(e) => setAutosaveEnabled(e.target.checked)} />
        <span>Autosave every 5 minutes</span>
      </label>
    </>
  )
}

function AiSection() {
  const openModels = useAiStore((s) => s.setSettingsOpen)
  return (
    <>
      <p>AI providers, API keys and local models are stored for your user account, not in the project.</p>
      <button type="button" title="Add, edit or remove AI models" onClick={() => openModels(true)}>
        AI models…
      </button>
    </>
  )
}

function GitSection() {
  const probe = useGitStore((s) => s.probe)
  return (
    <p>
      {probe === null
        ? 'Looking for git…'
        : probe.available
          ? `SaiLoR uses the git on your PATH: ${probe.version}.`
          : probe.error}
    </p>
  )
}

export const SETTINGS_SECTIONS: Array<{ id: string; title: string; Body: ComponentType }> = [
  { id: 'general', title: 'General', Body: GeneralSection },
  { id: 'ai', title: 'AI', Body: AiSection },
  { id: 'git', title: 'Git', Body: GitSection },
]

export function SettingsDialog() {
  const open = useStore((s) => s.userSettingsOpen)
  const setOpen = useStore((s) => s.setUserSettingsOpen)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useAiStore.getState().settingsOpen) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      back?.focus()
    }
  }, [open, setOpen])

  if (!open) return null

  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        ref={ref}
        className="modal settings-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-head">
          <strong id="settings-title">Settings</strong>
          <button type="button" className="icon-btn" title="Close settings" aria-label="Close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {SETTINGS_SECTIONS.map(({ id, title, Body }) => (
            <section key={id} aria-labelledby={`settings-${id}`}>
              <h3 id={`settings-${id}`}>{title}</h3>
              <Body />
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

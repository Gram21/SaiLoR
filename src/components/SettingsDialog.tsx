import { useEffect, useRef, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { useGitStore } from '../state/gitStore'
import { LANGUAGES, type Language, type Theme } from '../state/settings'
import { LANGUAGE_NAMES, getLanguage, setLanguage, useLanguage, useT, type MessageKey } from '../i18n'

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function GeneralSection() {
  const t = useT()
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
        <span>{t('settings.theme')}</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          <option value="light">{t('settings.theme.light')}</option>
          <option value="dark">{t('settings.theme.dark')}</option>
        </select>
      </label>
      <div className="settings-row" role="group" aria-labelledby="settings-font-label">
        <span id="settings-font-label">{t('settings.font')}</span>
        <span className="font-controls">
          <button type="button" className="icon-btn" title={t('settings.font.decreaseTitle')} aria-label={t('settings.font.decrease')} onClick={decreaseFont}>
            A−
          </button>
          <output aria-live="polite">{fontScale.toLocaleString(getLanguage(), { style: 'percent' })}</output>
          <button type="button" className="icon-btn" title={t('settings.font.increaseTitle')} aria-label={t('settings.font.increase')} onClick={increaseFont}>
            A+
          </button>
          <button type="button" className="icon-btn" title={t('settings.font.resetTitle')} onClick={resetFont}>
            {t('settings.font.reset')}
          </button>
        </span>
      </div>
      <label className="settings-row">
        <input type="checkbox" checked={autosaveEnabled} onChange={(e) => setAutosaveEnabled(e.target.checked)} />
        <span>{t('settings.autosave')}</span>
      </label>
    </>
  )
}

// [impl->req~ui-110~1]
function LanguageSection() {
  const t = useT()
  const lang = useLanguage()
  return (
    <label className="settings-row">
      <span>{t('settings.language.label')}</span>
      <select value={lang} onChange={(e) => setLanguage(e.target.value as Language)}>
        {LANGUAGES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  )
}

function AiSection() {
  const t = useT()
  const openModels = useAiStore((s) => s.setSettingsOpen)
  return (
    <>
      <p>{t('settings.ai.text')}</p>
      <button type="button" title={t('settings.ai.modelsTitle')} onClick={() => openModels(true)}>
        {t('settings.ai.models')}
      </button>
    </>
  )
}

function GitSection() {
  const t = useT()
  const probe = useGitStore((s) => s.probe)
  return (
    <p>
      {probe === null
        ? t('settings.git.looking')
        : probe.available
          ? t('settings.git.found', { version: probe.version })
          : probe.error}
    </p>
  )
}

// [impl->req~ui-90~1]
export const SETTINGS_SECTIONS: Array<{ id: string; title: MessageKey; Body: ComponentType }> = [
  { id: 'general', title: 'settings.section.general', Body: GeneralSection },
  { id: 'language', title: 'settings.section.language', Body: LanguageSection },
  { id: 'ai', title: 'settings.section.ai', Body: AiSection },
  { id: 'git', title: 'settings.section.git', Body: GitSection },
]

// [impl->req~ui-90~1]
export function SettingsDialog() {
  const t = useT()
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
          <strong id="settings-title">{t('settings.title')}</strong>
          <button type="button" className="icon-btn" title={t('settings.closeTitle')} aria-label={t('common.close')} onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {SETTINGS_SECTIONS.map(({ id, title, Body }) => (
            <section key={id} aria-labelledby={`settings-${id}`}>
              <h3 id={`settings-${id}`}>{t(title)}</h3>
              <Body />
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

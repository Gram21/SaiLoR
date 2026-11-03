import { useState } from 'react'
import { getPlatform } from '../platform'
import { copyText } from '../clipboard'
import type { MenuItem } from '../components/Dropdown'
import { useT } from '../i18n'

/**
 * The "Copy to clipboard" / "Save to file…" pair behind an Export button —
 * built once here so the per-paper disagreement view and the project-wide
 * overview offer the identical two choices rather than each wiring its own.
 *
 * `getText` is called lazily, at the moment the reviewer picks an option, not
 * when the menu is built — so the export always reflects whatever is on
 * screen right then, even if the dropdown was left open for a while.
 */
export function useExportTextMenu(getText: () => string, suggestedFileName: string) {
  // A one-line confirmation or error, auto-clearing — the same "say what
  // happened, then get out of the way" shape the autosave indicator uses.
  // Session-only local state: nothing here is worth surviving a re-render of
  // the dialog itself, let alone a reload.
  const [status, setStatus] = useState<string | null>(null)
  const t = useT()

  const announce = (message: string) => {
    setStatus(message)
    window.setTimeout(() => setStatus(null), 3000)
  }

  const items: MenuItem[] = [
    {
      type: 'item',
      label: t('app.export.copy'),
      onSelect: () => {
        void copyText(getText()).then((ok) => announce(ok ? t('app.export.copied') : t('app.export.copyFailed')))
      },
    },
    {
      type: 'item',
      label: t('app.export.saveFile'),
      onSelect: () => {
        void (async () => {
          const platform = getPlatform()
          const path = await platform.pickTextExportPath(suggestedFileName)
          if (!path) return // cancelled
          const res = await platform.writeTextFile(path, getText())
          announce(res.ok ? t('app.export.saved', { path: res.path }) : t('app.export.saveFailed', { error: res.error }))
        })()
      },
    },
  ]

  return { items, status }
}

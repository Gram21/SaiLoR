import type { ElectronApplication } from '@playwright/test'

/**
 * Quit the app without hanging on the native "Do you want to save the changes?"
 * box (electron/main.ts `promptUnsavedChanges`) that a dirty project opens on
 * close — Playwright cannot click native dialogs, so answer "Don't Save" in the
 * main process first. Specs that only inspect state discard it anyway.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = args[args.length - 1] as { buttons?: string[] }
      const dontSave = (opts.buttons ?? []).findIndex((b) => /don.?t save/i.test(b))
      return { response: dontSave >= 0 ? dontSave : 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  await app.close()
}

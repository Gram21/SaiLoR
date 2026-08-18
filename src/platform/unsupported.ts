import type { PlatformAdapter } from './adapter'
import type { RecentEntry } from './recents'

const UNSUPPORTED = 'SaiLoR for the web is discontinued — use the desktop app.'

/**
 * Stands in for the platform outside Electron. `App.tsx` shows a "use the
 * desktop app" notice and blocks every project-opening UI before any of this
 * can be reached from a user action — the only things genuinely read before
 * that gate ever renders are `kind` (`LlmSettingsDialog.tsx`) and
 * `getRecents` (`store.ts`'s initial state, at module load). Every other
 * method is a backstop for a call this app's own gating says can't happen, so
 * it is one `Proxy` trap rather than thirty individual stub methods.
 */
export function createUnsupportedAdapter(): PlatformAdapter {
  const real = {
    kind: 'browser' as const,
    getRecents: (): RecentEntry[] => [],
  }
  return new Proxy(real as unknown as PlatformAdapter, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return () => {
        throw new Error(UNSUPPORTED)
      }
    },
  })
}

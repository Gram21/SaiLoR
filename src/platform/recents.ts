/**
 * Recent-projects list, persisted in localStorage. Entries are platform-opaque:
 * on Electron `id` is the absolute file path; in the browser it is a key into
 * the IndexedDB handle store (see idb.ts). Newest first, capped at MAX_RECENTS.
 */

export interface RecentEntry {
  id: string
  /** File name, e.g. "review.json". */
  name: string
  /** Full path — Electron only. Shown so same-named projects can be told apart. */
  path?: string
  /** The project's own title, when its JSON sets one. Preferred over `name`. */
  title?: string
  /**
   * Whether the file is currently reachable. Computed at runtime (never
   * persisted): a missing file keeps its entry — the user may plug the drive
   * back in — it is just shown greyed out and can't be opened.
   */
  available?: boolean
}

export const MAX_RECENTS = 5

export function readRecents(key: string): RecentEntry[] {
  try {
    const raw = localStorage?.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string')
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

function write(key: string, list: RecentEntry[]): void {
  try {
    // `available` is a runtime observation, not part of the remembered entry.
    const persisted = list.slice(0, MAX_RECENTS).map(({ available: _drop, ...rest }) => rest)
    localStorage?.setItem(key, JSON.stringify(persisted))
  } catch {
    /* ignore */
  }
}

/** Move/insert `entry` to the front (dedup by id), cap the list, persist, return it. */
export function pushRecent(key: string, entry: RecentEntry): RecentEntry[] {
  const list = [entry, ...readRecents(key).filter((e) => e.id !== entry.id)].slice(0, MAX_RECENTS)
  write(key, list)
  return list
}

/** Remove an entry by id (e.g. when the file can no longer be opened), persist, return the rest. */
export function removeRecent(key: string, id: string): RecentEntry[] {
  const list = readRecents(key).filter((e) => e.id !== id)
  write(key, list)
  return list
}

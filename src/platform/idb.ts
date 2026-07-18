/**
 * Tiny IndexedDB wrapper used (browser only) to persist FileSystemFileHandle
 * objects for the recent-projects list. Handles are structured-cloneable, so
 * they survive a reload — reopening one only needs a permission re-grant.
 */

// Kept at the pre-rename name on purpose: renaming the database would strand
// every existing user's saved handles, i.e. silently empty their recents list.
const DB_NAME = 'slr-helper'
const STORE = 'handles'
const VERSION = 1

/**
 * Every promise here settles on abort as well as on error.
 *
 * A transaction can abort *without* any request having failed — the connection
 * force-closed by clearing site data, a `deleteDatabase` from devtools, origin
 * eviction under storage pressure. Those fire `onabort` and nothing else, so a
 * promise waiting only on `oncomplete`/`onerror` never settled, its `finally`
 * never ran, and the connection leaked. That is not an abstract leak:
 * `openProject` awaits `rememberHandle` inline, so the picker returned a file
 * and the app just never showed it — no error, no timeout, `busy` stuck on
 * forever, and the caller's own try/catch powerless because there was no
 * rejection to catch. An open request can be blocked the same way.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'))
  })
}

export async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

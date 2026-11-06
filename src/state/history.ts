export const HISTORY_LIMIT = 100

/** Push a pre-mutation snapshot onto the undo stack and clear the redo stack. */
export function pushPast<T>(s: { past: T[]; future: T[] }, snap: T): void {
  s.past.push(snap)
  if (s.past.length > HISTORY_LIMIT) s.past.shift()
  s.future = []
}

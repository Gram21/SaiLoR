/**
 * Reads every id's associated value concurrently rather than one at a time,
 * preserving the exact id→result association regardless of which read
 * settles first. Extracted from `readProjectText` (`electron/main.ts`) purely
 * for testability — `electron/` sits outside vitest's test scope, so the
 * concurrency-orchestration logic that used to live inline there (and is
 * exactly the kind of thing a reordering/off-by-one bug could hide in) lives
 * here instead, where it can actually be exercised with reads that resolve
 * out of order.
 *
 * A rejecting read still rejects the whole call, the same "the load failed"
 * outcome the original sequential loop had for a failing paper — but since
 * every read is already in flight rather than the loop stopping at the first
 * failure, if two or more ids fail at once it is not guaranteed to be the
 * *first* one (by `ids` order) whose error surfaces, only that it is a real
 * failure from one of them. Nothing in this codebase distinguishes "which of
 * several simultaneous failures" was reported, so this is an accepted,
 * harmless difference from the old sequential behavior, not a regression.
 */
export async function readAllConcurrently<T>(
  ids: string[],
  read: (id: string) => Promise<T>,
): Promise<Map<string, T>> {
  const results = await Promise.all(ids.map(read))
  return new Map(ids.map((id, i) => [id, results[i]]))
}

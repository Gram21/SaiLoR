/** Only a finite non-negative number survives; anything else (string, NaN, negative, missing) is dropped. */
export function validPrice(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** Only a finite positive integer survives — a System One target's `maxStateTokens`. */
export function validPositiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
}

/**
 * Build the headers `llm:call` actually sends, given whether a key is stored.
 *
 * A key present always wins (splice it in). No key and `noKey` not set is a
 * hard error — the target isn't usable. No key but `noKey` set: a header
 * built to carry a key (it still contains the unsubstituted sentinel) has
 * nothing to send, so it's dropped rather than sent literally as `{{apiKey}}`.
 */
export function buildCallHeaders(
  headers: Record<string, string>,
  sentinel: string,
  opts: { apiKey?: string; noKey?: boolean },
): Record<string, string> {
  if (opts.apiKey !== undefined) {
    return Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, v.split(sentinel).join(opts.apiKey)]),
    )
  }
  if (!opts.noKey) throw new Error('No API key is stored for this target.')
  return Object.fromEntries(Object.entries(headers).filter(([, v]) => !v.includes(sentinel)))
}

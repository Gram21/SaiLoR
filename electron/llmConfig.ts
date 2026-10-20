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

/** System One wire flavor; anything else is dropped (the default is Jev's route). */
export function validSystemOneFlavor(v: unknown): 'jev' | 'cloudflare' | undefined {
  return v === 'jev' || v === 'cloudflare' ? v : undefined
}

/** A Cloudflare account id: 32 lowercase hex characters. */
export function validAccountId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-f0-9]{32}$/.test(v) ? v : undefined
}

/** A managed local model: only a well-formed catalog id survives (it is checked against the catalog when used). */
export function validManaged(v: unknown): { catalogId: string } | undefined {
  const id = (v as { catalogId?: unknown } | null)?.catalogId
  return typeof id === 'string' && /^[a-z0-9._-]{1,64}$/.test(id) ? { catalogId: id } : undefined
}

/**
 * Where an `llm:call` for a managed target really goes: the stored placeholder
 * origin is swapped for the running local server's, keeping path and query.
 * Only the local server's own `/v1/` API and `/health` are reachable this way.
 */
export function managedTargetUrl(requestUrl: string, serverBase: string): string {
  const u = new URL(requestUrl)
  if (!(u.pathname.startsWith('/v1/') || u.pathname === '/health')) {
    throw new Error(`Refusing to call ${u.pathname} on the local model server.`)
  }
  return new URL(u.pathname + u.search, serverBase).toString()
}

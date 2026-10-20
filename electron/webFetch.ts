// Pure, unit-testable checks for the `web:fetch` trust boundary in
// electron/main.ts. The URL an agent asks to fetch comes from an LLM that may
// itself have read attacker-controlled page text, so every hostname/address it
// names has to be checked before a request goes out — not just the literal
// text of the URL, but where it actually resolves to (see main.ts for the DNS
// lookup that feeds `isBlockedAddress`).

import net from 'node:net'

/** True if `address` (a literal IPv4/IPv6 address, e.g. from a DNS lookup) must not be reached. */
export function isBlockedAddress(address: string): boolean {
  const kind = net.isIP(address)
  if (kind === 4) return isBlockedIPv4(address)
  if (kind === 6) return isBlockedIPv6(address)
  return true // not a literal IP at all — never valid input here, refuse
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0) return true // "this network" 0.0.0.0/8
  if (a === 10) return true // private 10/8
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true // private 172.16/12
  if (a === 192 && b === 168) return true // private 192.168/16
  if (a >= 224) return true // multicast 224/4 + reserved 240/4: never a public unicast host
  return false
}

function isBlockedIPv6(address: string): boolean {
  const ip = address.toLowerCase()
  if (ip === '::1' || ip === '::') return true
  // IPv4-mapped, e.g. "::ffff:127.0.0.1" — Node's dns.lookup returns this dotted form.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIPv4(mapped[1])
  // Same, in the hex form `new URL` normalizes literals to, e.g. "::ffff:7f00:1".
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)]
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (ip.startsWith('fe80:')) return true // link-local fe80::/10
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return true // unique-local fc00::/7
  if (ip.startsWith('ff')) return true // multicast ff00::/8
  return false
}

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal']

/** True for hostnames that are local/internal by name alone, before any DNS lookup. */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'localhost' || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => h.endsWith(suffix))
}

export interface FetchUrlCheck {
  ok: boolean
  error?: string
  /** Present when ok — the hostname to resolve (or check directly, if itself a literal IP). */
  hostname?: string
}

/** Scheme, credential and hostname-by-name checks that need no DNS lookup. Re-run on every redirect hop. */
export function validateFetchUrl(raw: string): FetchUrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'Invalid URL.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Unsupported URL scheme "${url.protocol}"` }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed.' }
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (isBlockedHostname(hostname)) {
    return { ok: false, error: `Refusing to fetch local/internal host "${hostname}".` }
  }
  if (net.isIP(hostname) && isBlockedAddress(hostname)) {
    return { ok: false, error: `Refusing to fetch local/internal address "${hostname}".` }
  }
  return { ok: true, hostname }
}

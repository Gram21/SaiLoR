/**
 * The repository URL and the clone destination are user input that reach a
 * spawned process, so they are checked here, once, and the Electron main process
 * imports this module rather than keeping a second copy — see its comment at the
 * import.
 *
 * `execFile` with an argument array and a `--` terminator already stop a URL from
 * being read as an option. What they do not stop is git's own remote-helper
 * syntax: `ext::sh -c '…'` is a transport that makes git run a program named by
 * the URL, which is arbitrary code execution spelled as a URL. That is why the
 * check below is an allowlist of transports rather than a blocklist of characters.
 *
 * Nothing here weakens git: host-key checking, credential helpers and askpass
 * programs are the user's own configuration and are never touched.
 */

const ALLOWED_SCHEMES = ['https://', 'http://', 'ssh://', 'git://', 'git+ssh://', 'file://']

/** scp-like shorthand: user@host:path (but not user@host:/abs — that's ssh:// territory
 *  spelled with a drive-letter-free colon; a *following* slash is a Windows path instead). */
const SCP_LIKE = /^[\w.+-]+@[\w.-]+:(?!\/)/
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/
/** A leading "scheme::" names a git remote-helper — `ext::` is the dangerous one
 *  (it runs a shell command named by the rest of the URL), but any of them hands
 *  control of the transport to whatever the URL names. Requires two consecutive
 *  colons, so "https://" (which has none) can never match this. */
const REMOTE_HELPER = /^[A-Za-z0-9+.-]*::/

/** Null when the URL is acceptable; otherwise the message to show the user. */
export function validateGitUrl(raw: string): string | null {
  const url = raw.trim()
  if (!url) return 'Enter the repository URL.'
  if (/[\0\r\n]/.test(url)) return 'The URL contains a line break or a null byte.'
  if (url.startsWith('-')) return 'A URL cannot start with "-" — git would read it as an option.'
  if (REMOTE_HELPER.test(url)) {
    return 'Remote-helper URLs ("ext::…") are not accepted: they make git run a program named by the URL.'
  }
  if (ALLOWED_SCHEMES.some((s) => url.toLowerCase().startsWith(s))) return null
  if (SCP_LIKE.test(url)) return null
  if (url.startsWith('/')) return null
  if (WINDOWS_PATH.test(url)) return null
  return 'Use an https://, ssh://, git:// or file:// URL, a git@host:org/repo path, or an absolute path to a local repository.'
}

/** Null when `dest` is a usable clone destination; otherwise the message. */
export function validateClonePath(dest: string): string | null {
  const d = dest.trim()
  if (!d) return 'Choose where to clone the repository.'
  if (/[\0\r\n]/.test(d)) return 'The destination contains a line break or a null byte.'
  if (d.startsWith('-')) return 'A destination cannot start with "-" — git would read it as an option.'
  if (!(d.startsWith('/') || WINDOWS_PATH.test(d))) return 'The destination must be an absolute path.'
  return null
}

/**
 * The directory name `git clone <url>` would create — so the dialog can show the
 * reviewer where the repository will actually land before they confirm. Null when
 * no safe name can be derived, which is also what disables the Clone button —
 * the rejection is what stops `join(parent, name)` escaping the folder the user
 * chose (a name of "." or ".." or one containing a separator would).
 */
export function repoNameFromUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const url = trimmed.split('#')[0].split('?')[0]
  if (!url) return null

  // Strip a recognized scheme — and, for one, the authority before the first
  // "/" that follows it (a domain name is not a repository name) — or the
  // scp-like "user@host:" prefix, leaving just the path to derive a name from.
  // A bare local path (POSIX or Windows) has neither, so it passes through as-is.
  let path: string
  const scheme = ALLOWED_SCHEMES.find((s) => url.toLowerCase().startsWith(s))
  if (scheme) {
    const rest = url.slice(scheme.length)
    if (rest.startsWith('/')) {
      path = rest // e.g. file:///abs/repo — no authority component
    } else {
      const slash = rest.indexOf('/')
      path = slash === -1 ? '' : rest.slice(slash)
    }
  } else {
    const scp = SCP_LIKE.exec(url)
    path = scp ? url.slice(scp[0].length) : url
  }

  const segs = path.split(/[/\\]/).filter(Boolean)
  let name = segs[segs.length - 1]
  if (!name) return null
  if (name.endsWith('.git')) name = name.slice(0, -4)
  if (!name || name === '.' || name === '..' || /\0/.test(name)) return null
  return name
}

/**
 * Update check: compare the running version against the latest GitHub release.
 *
 * IMPORTANT — this only works while the repository is **public**. GitHub's
 * releases API answers 404 to an unauthenticated request for a private repo,
 * and the only ways around that would be to embed a token in the shipped app
 * (a credential leak — the app is distributed to users) or to run a proxy. So
 * the check is written to fail *silently*: on 404/403/network error the app
 * simply shows no update notice. It starts working the moment the repo is made
 * public, with no code change.
 *
 * The API allows 60 unauthenticated requests per hour per IP, so the result is
 * cached (see CHECK_INTERVAL_MS) rather than fetched on every launch.
 */

export const RELEASES_URL = 'https://github.com/Gram21/slr-helper/releases'
const LATEST_RELEASE_API = 'https://api.github.com/repos/Gram21/slr-helper/releases/latest'

/** How long a check result stays fresh. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateInfo {
  /** Version of the newest release, e.g. "0.2.0". */
  latest: string
  /** The release page — always usable as a fallback. */
  url: string
  /** Direct download of the installer for this machine, when one matches. */
  download?: { url: string; name: string; label: string }
}

/** A release asset as GitHub reports it. */
export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

/** The machine we're running on. Electron reports it; a browser has no arch. */
export interface OsInfo {
  platform: string
  arch: string
}

/**
 * The installer matching this machine, from a release's assets.
 *
 * Matching is by the OS/arch we put in the artifact names
 * (`SLR Helper-0.2.0-macos-arm64.dmg`), so it stays correct as long as
 * package.json's `artifactName` patterns do. Returns null when nothing matches
 * — the caller then falls back to the release page rather than offering the
 * wrong binary.
 */
export function pickInstaller(assets: ReleaseAsset[], os: OsInfo | null): UpdateInfo['download'] {
  if (!os) return undefined

  const isMac = os.platform === 'darwin'
  const isWin = os.platform === 'win32'
  const isLinux = os.platform === 'linux'

  let match: RegExp | null = null
  let label = ''
  if (isMac) {
    const arm = os.arch === 'arm64'
    match = arm ? /macos-arm64\.dmg$/i : /macos-x64\.dmg$/i
    label = arm ? 'macOS (Apple Silicon)' : 'macOS (Intel)'
  } else if (isWin) {
    match = /windows-.*\.exe$/i
    label = 'Windows'
  } else if (isLinux) {
    match = /linux-.*\.AppImage$/i
    label = 'Linux'
  }
  if (!match) return undefined

  const asset = assets.find((a) => match.test(a.name))
  if (!asset) return undefined
  return { url: asset.browser_download_url, name: asset.name, label }
}

/** Numeric components of a version, ignoring a leading "v" and any pre-release suffix. */
function parts(version: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim())
  if (!m) return null
  return { nums: m[1].split('.').map(Number), pre: m[2] ?? '' }
}

/**
 * True when `latest` is a strictly newer version than `current`.
 *
 * A pre-release sorts *before* the same release without the suffix
 * (1.0.0-beta < 1.0.0), matching semver.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parts(latest)
  const b = parts(current)
  if (!a || !b) return false

  const len = Math.max(a.nums.length, b.nums.length)
  for (let i = 0; i < len; i++) {
    const x = a.nums[i] ?? 0
    const y = b.nums[i] ?? 0
    if (x !== y) return x > y
  }
  // Same numbers: a release beats a pre-release of it; otherwise compare the tags.
  if (a.pre === b.pre) return false
  if (!a.pre) return true
  if (!b.pre) return false
  return a.pre > b.pre
}

/**
 * The latest published release, or null when it can't be determined (private
 * repo, offline, rate-limited, no releases yet). Never throws.
 */
export async function fetchLatestRelease(
  os: OsInfo | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  try {
    const res = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    // 404 while the repo is private, 403 when rate-limited — both mean "can't tell".
    if (!res.ok) return null
    const data = (await res.json()) as {
      tag_name?: string
      html_url?: string
      draft?: boolean
      assets?: ReleaseAsset[]
    }
    if (!data.tag_name || data.draft) return null
    return {
      latest: data.tag_name.replace(/^v/, ''),
      url: data.html_url || RELEASES_URL,
      download: pickInstaller(data.assets ?? [], os),
    }
  } catch {
    // Offline, blocked, or a malformed response — no notice is better than a wrong one.
    return null
  }
}

/**
 * An update notice for `current`, or null if it is up to date / unknowable.
 * Exported separately from the fetch so it can be tested without the network.
 */
export function updateFrom(current: string, release: UpdateInfo | null): UpdateInfo | null {
  if (!release) return null
  return isNewerVersion(release.latest, current) ? release : null
}

import { describe, it, expect } from 'vitest'
import {
  isNewerVersion,
  fetchLatestRelease,
  updateFrom,
  pickInstaller,
  RELEASES_URL,
} from './version'

describe('isNewerVersion', () => {
  it('compares each numeric component, not the string', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    // "0.10.0" > "0.9.0" numerically, even though it sorts lower as a string.
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true)
  })

  it('is false for the same or an older version', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false)
  })

  it('ignores a leading v and tolerates short versions', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('v0.1.0', 'v0.1.0')).toBe(false)
    expect(isNewerVersion('1.1', '1.0.9')).toBe(true)
    expect(isNewerVersion('1.0', '1.0.0')).toBe(false)
  })

  it('sorts a pre-release below the release it precedes', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-beta')).toBe(true)
    expect(isNewerVersion('1.0.0-beta', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true)
  })

  it('never claims an update from a version it cannot parse', () => {
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.2.0', 'unknown')).toBe(false)
  })
})

/** A minimal stand-in for the bits of Response that fetchLatestRelease touches. */
const reply = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

describe('fetchLatestRelease', () => {
  it('returns the release, stripping the tag prefix', async () => {
    const res = await fetchLatestRelease(null, async () =>
      reply(200, { tag_name: 'v0.2.0', html_url: 'https://example.test/r/v0.2.0' }),
    )
    expect(res).toEqual({ latest: '0.2.0', url: 'https://example.test/r/v0.2.0' })
  })

  it('returns null for a private repo (404) rather than throwing', async () => {
    // This is the current state of the repo: unauthenticated callers get a 404,
    // so the app must simply show no notice.
    expect(await fetchLatestRelease(null, async () => reply(404, { message: 'Not Found' }))).toBeNull()
  })

  it('returns null when rate-limited (403) or offline', async () => {
    expect(await fetchLatestRelease(null, async () => reply(403, {}))).toBeNull()
    expect(
      await fetchLatestRelease(null, async () => {
        throw new Error('network down')
      }),
    ).toBeNull()
  })

  it('ignores a draft release and a response with no tag', async () => {
    expect(await fetchLatestRelease(null, async () => reply(200, { tag_name: 'v9.9.9', draft: true }))).toBeNull()
    expect(await fetchLatestRelease(null, async () => reply(200, {}))).toBeNull()
  })

  it('falls back to the releases page when the payload has no url', async () => {
    const res = await fetchLatestRelease(null, async () => reply(200, { tag_name: '0.3.0' }))
    expect(res).toEqual({ latest: '0.3.0', url: RELEASES_URL })
  })
})

describe('pickInstaller', () => {
  // The names the release workflow actually produces.
  const assets = [
    { name: 'SaiLoR-0.2.0-macos-arm64.dmg', browser_download_url: 'u/mac-arm' },
    { name: 'SaiLoR-0.2.0-macos-x64.dmg', browser_download_url: 'u/mac-intel' },
    { name: 'SaiLoR-0.2.0-windows-x64.exe', browser_download_url: 'u/win' },
    { name: 'SaiLoR-0.2.0-linux-x64.AppImage', browser_download_url: 'u/linux' },
  ]

  it('picks the dmg matching the Mac architecture', () => {
    // Handing an Intel Mac the arm64 build (or vice versa) is the whole point.
    expect(pickInstaller(assets, { platform: 'darwin', arch: 'arm64' })?.url).toBe('u/mac-arm')
    expect(pickInstaller(assets, { platform: 'darwin', arch: 'x64' })?.url).toBe('u/mac-intel')
  })

  it('labels the download so the user knows what they are getting', () => {
    expect(pickInstaller(assets, { platform: 'darwin', arch: 'arm64' })?.label).toBe(
      'macOS (Apple Silicon)',
    )
    expect(pickInstaller(assets, { platform: 'darwin', arch: 'x64' })?.label).toBe('macOS (Intel)')
  })

  it('picks the Windows and Linux installers', () => {
    expect(pickInstaller(assets, { platform: 'win32', arch: 'x64' })?.url).toBe('u/win')
    expect(pickInstaller(assets, { platform: 'linux', arch: 'x64' })?.url).toBe('u/linux')
  })

  it('offers nothing in the browser, which has no installer', () => {
    expect(pickInstaller(assets, null)).toBeUndefined()
  })

  it('offers nothing rather than the wrong binary when no asset matches', () => {
    expect(pickInstaller([], { platform: 'darwin', arch: 'arm64' })).toBeUndefined()
    // An unknown platform must not fall through to some other OS's installer.
    expect(pickInstaller(assets, { platform: 'freebsd', arch: 'x64' })).toBeUndefined()
    // A release with only a Windows build offers a Mac user nothing.
    expect(pickInstaller([assets[2]], { platform: 'darwin', arch: 'arm64' })).toBeUndefined()
  })

  it('is wired through fetchLatestRelease', async () => {
    const res = await fetchLatestRelease({ platform: 'linux', arch: 'x64' }, async () =>
      reply(200, { tag_name: 'v0.2.0', html_url: 'p', assets }),
    )
    expect(res?.download).toEqual({
      url: 'u/linux',
      name: 'SaiLoR-0.2.0-linux-x64.AppImage',
      label: 'Linux',
    })
  })
})

describe('updateFrom', () => {
  it('notifies only when the release is actually newer', () => {
    expect(updateFrom('0.1.0', { latest: '0.2.0', url: RELEASES_URL })).not.toBeNull()
    expect(updateFrom('0.2.0', { latest: '0.2.0', url: RELEASES_URL })).toBeNull()
    expect(updateFrom('0.3.0', { latest: '0.2.0', url: RELEASES_URL })).toBeNull()
  })

  it('says nothing when the release could not be determined', () => {
    expect(updateFrom('0.1.0', null)).toBeNull()
  })

  it('orders pre-releases past the ninth numerically, not lexicographically', () => {
    // "rc.10" < "rc.2" as strings, so this inverted at exactly the tenth RC:
    // rc.2 was never offered rc.10, and rc.10 was offered rc.2 as an "update".
    expect(isNewerVersion('1.0.1-rc.10', '1.0.1-rc.2')).toBe(true)
    expect(isNewerVersion('1.0.1-rc.2', '1.0.1-rc.10')).toBe(false)
    expect(isNewerVersion('1.0.1-beta.9', '1.0.1-beta.11')).toBe(false)
  })

  it('sorts a numeric pre-release identifier below an alphanumeric one', () => {
    expect(isNewerVersion('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(true)
    expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(false)
  })

  it('treats a longer pre-release tag as newer than its own prefix', () => {
    expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha')).toBe(true)
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-alpha.1')).toBe(false)
  })
})

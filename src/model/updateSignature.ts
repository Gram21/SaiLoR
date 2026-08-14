/**
 * Verifies that a downloaded `electron-updater` feed file (`latest.yml` /
 * `latest-linux.yml`) was produced by this project's own release pipeline,
 * not merely that it wasn't corrupted in transit.
 *
 * `electron-updater` already checks the downloaded installer's sha512 against
 * the value declared in the feed file — but that value comes from the same
 * channel as the installer itself, so it only catches transport corruption.
 * Anyone who can publish to the release (a leaked token, a compromised
 * maintainer account) can publish a matching hash for a malicious installer
 * too. There is no purchased code-signing certificate for Windows/Linux (see
 * `release.yml`'s comment on the matter), so `electron-updater`'s own
 * publisher-signature check has nothing to verify against either.
 *
 * This closes that gap independently: the release workflow signs the feed
 * file with an Ed25519 key it alone holds (`scripts/sign-release.cjs`), and
 * `electron/main.ts` verifies the signature against the public key below
 * before ever calling `autoUpdater.downloadUpdate()`. The public key is
 * baked into the app at build time — never fetched from the same release
 * channel being verified — so a compromised release can't also republish a
 * matching fake key.
 *
 * Lives here rather than in `electron/main.ts` for the same reason
 * `src/git/url.ts` etc. do: it is a security gate, so it is written once,
 * reachable by the test suite, and importable by the main process.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** This project's release-signing public key (raw 32 Ed25519 bytes, base64).
 *  The matching private key is a GitHub Actions secret used only by
 *  `release.yml`'s signing step — never committed, never present here. */
export const RELEASE_PUBLIC_KEY_B64 = 'AYrBXbbSurN/6Rzvlsgqp8TdBVwcQq5Y5Yn53/L4gvw='

function publicKeyFromBase64(publicKeyB64: string) {
  const raw = Buffer.from(publicKeyB64, 'base64')
  // Node has no "raw" import format for OKP keys; JWK is the simplest format
  // that accepts one directly (RFC 8037 — `x` is the raw public key, base64url).
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  })
}

/**
 * `true` when `signatureB64` (base64) is a valid Ed25519 signature of `data`
 * under `publicKeyB64` (raw 32 bytes, base64). `false` for any failure —
 * malformed key, malformed signature, or a genuine mismatch — since the
 * caller only ever needs "trusted" vs. "not," never the reason.
 */
export function verifyReleaseSignature(data: Uint8Array, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = publicKeyFromBase64(publicKeyB64)
    const signature = Buffer.from(signatureB64, 'base64')
    return cryptoVerify(null, Buffer.from(data), key, signature)
  } catch {
    return false
  }
}

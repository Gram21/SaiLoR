import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifyReleaseSignature } from './updateSignature'

/** A fresh Ed25519 keypair per test run, in the same raw/base64 shape the
 *  release pipeline and `verifyReleaseSignature` use — deliberately not
 *  `RELEASE_PUBLIC_KEY_B64`, so a test failure can never be masked by
 *  accidentally signing and verifying with the same real key. */
function freshKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const publicKeyB64 = pubDer.subarray(pubDer.length - 32).toString('base64')
  return { privateKey, publicKeyB64 }
}

function signB64(data: Uint8Array, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  return sign(null, Buffer.from(data), privateKey).toString('base64')
}

describe('verifyReleaseSignature', () => {
  it('accepts a genuine signature', () => {
    const { privateKey, publicKeyB64 } = freshKeyPair()
    const data = new TextEncoder().encode('latest.yml contents')
    const sig = signB64(data, privateKey)
    expect(verifyReleaseSignature(data, sig, publicKeyB64)).toBe(true)
  })

  it('rejects a signature over different data (tampered feed file)', () => {
    const { privateKey, publicKeyB64 } = freshKeyPair()
    const data = new TextEncoder().encode('latest.yml contents')
    const sig = signB64(data, privateKey)
    const tampered = new TextEncoder().encode('latest.yml CONTENTS')
    expect(verifyReleaseSignature(tampered, sig, publicKeyB64)).toBe(false)
  })

  it('rejects a signature made with a different key (untrusted publisher)', () => {
    const { publicKeyB64 } = freshKeyPair()
    const other = freshKeyPair()
    const data = new TextEncoder().encode('latest.yml contents')
    const sig = signB64(data, other.privateKey)
    expect(verifyReleaseSignature(data, sig, publicKeyB64)).toBe(false)
  })

  it('rejects a malformed signature', () => {
    const { publicKeyB64 } = freshKeyPair()
    const data = new TextEncoder().encode('latest.yml contents')
    expect(verifyReleaseSignature(data, 'not-base64-signature-data', publicKeyB64)).toBe(false)
  })

  it('rejects a malformed public key', () => {
    const data = new TextEncoder().encode('latest.yml contents')
    expect(verifyReleaseSignature(data, 'AAAA', 'not-a-valid-key')).toBe(false)
  })
})

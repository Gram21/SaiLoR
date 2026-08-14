// Signs an electron-updater feed file (`latest.yml` / `latest-linux.yml`)
// with this project's Ed25519 release-signing key, so `electron/main.ts` can
// verify it came from this release pipeline before ever downloading an
// update — see `src/model/updateSignature.ts` for why. Run once per feed
// file by `release.yml`; writes `<path>.sig` (the base64 signature) next to
// it, which `release.yml` then attaches to the GitHub release alongside the
// file it signs.
//
// The private key never lives in this repository — it is the
// RELEASE_SIGNING_PRIVATE_KEY secret, a PEM-encoded Ed25519 private key,
// injected only into the release workflow's environment.
const { createPrivateKey, sign } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')

const ymlPath = process.argv[2]
const privatePem = process.env.RELEASE_SIGNING_PRIVATE_KEY

if (!ymlPath) {
  console.error('Usage: RELEASE_SIGNING_PRIVATE_KEY=<pem> node scripts/sign-release.cjs <path-to-yml>')
  process.exit(1)
}
if (!privatePem) {
  console.error('RELEASE_SIGNING_PRIVATE_KEY is not set.')
  process.exit(1)
}

const key = createPrivateKey({ key: privatePem, format: 'pem' })
const data = readFileSync(ymlPath)
const signature = sign(null, data, key)
writeFileSync(`${ymlPath}.sig`, signature.toString('base64'))
console.log(`Signed ${ymlPath} -> ${ymlPath}.sig`)

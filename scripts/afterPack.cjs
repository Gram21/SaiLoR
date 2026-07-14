const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * Ad-hoc sign the macOS app bundle.
 *
 * Without a Developer ID certificate, electron-builder leaves the app unsigned;
 * all it carries is the linker-signed stub the toolchain emits, which is not a
 * valid *bundle* signature (`codesign --verify` fails, and the identifier is
 * "Electron" rather than our appId). Once such an app is downloaded it also
 * carries the quarantine flag, and macOS reports the combination as
 *
 *     "SLR Helper" is damaged and can't be opened.
 *
 * which is a dead end for the user — the usual right-click → Open escape hatch
 * does not apply to "damaged".
 *
 * A valid *ad-hoc* signature costs nothing (no Apple account, no notarization)
 * and downgrades that to the ordinary "unidentified developer" prompt, which the
 * user can bypass. Notarizing with a real Developer ID is still the only way to
 * get no prompt at all — see openwiki/operations.md.
 *
 * If a real certificate IS configured, electron-builder signs the app properly
 * and this hook must not clobber it.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed  ${app}`)
}

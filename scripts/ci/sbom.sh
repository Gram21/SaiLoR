#!/usr/bin/env bash
# Write CycloneDX SBOMs for the npm and Rust dependencies. Needs npm 10+ and cargo-cyclonedx.
# Usage: scripts/ci/sbom.sh <output dir>
set -euo pipefail
cd "$(dirname "$0")/../.."
out="$(mkdir -p "${1:?usage: $0 <output dir>}" && cd "$1" && pwd)"
npm sbom --omit=dev --package-lock-only --sbom-format cyclonedx > "$out/sbom-npm.cdx.json"
cargo cyclonedx --manifest-path src-tauri/Cargo.toml --format json --override-filename sbom-rust.cdx
mv src-tauri/sbom-rust.cdx.json "$out/"
ls -l "$out"

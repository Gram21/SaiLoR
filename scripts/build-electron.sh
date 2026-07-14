#!/usr/bin/env bash
#
# Build the packaged Electron desktop app for the current operating system.
#
# electron-builder auto-detects the host OS and produces the matching target
# (dmg on macOS, nsis .exe on Windows, AppImage on Linux) into ./release/.
# The real work lives here so it can be run locally and on any CI provider;
# the CI workflow only provides the per-OS runner and, on GitHub, uploads the
# artifacts to the release.
#
#     ./scripts/build-electron.sh
#
# Environment variables:
#   SKIP_INSTALL=1   Skip dependency installation (deps already present).
#
set -euo pipefail

# Run from the repository root regardless of where the script is invoked from.
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

step "Node.js $(node -v) / npm $(npm -v)"

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  step "Installing dependencies (npm ci)"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
else
  step "Skipping dependency installation (SKIP_INSTALL=1)"
fi

step "Building packaged Electron app (electron-builder)"
npm run build:electron

step "Artifacts in ./release:"
ls -lh release/ || true

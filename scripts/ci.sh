#!/usr/bin/env bash
#
# Continuous-integration script for SaiLoR.
#
# This is the single source of truth for "does the app build and pass its
# checks". CI providers (GitHub Actions, GitLab CI, …) should do nothing more
# than check out the code, provide a Node.js toolchain, and run this script.
# Keeping the real work here means you can run the exact same checks locally:
#
#     ./scripts/ci.sh
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
  # Use a clean, lockfile-exact install when a lockfile is present; otherwise
  # fall back to a regular install so the script also works on fresh clones
  # that haven't committed a lockfile.
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
else
  step "Skipping dependency installation (SKIP_INSTALL=1)"
fi

step "Type checking (tsc -b)"
npm run typecheck

step "Checking wiki links (openwiki/, user-guide/)"
npm run check:wiki

step "Running tests (vitest)"
npm test

step "Building static SPA (vite build)"
npm run build

step "CI passed ✔"

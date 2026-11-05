#!/usr/bin/env bash
# Tauri end-to-end test through tauri-driver (Linux and Windows only).
# Needs Node.js, Rust and tauri-driver (`cargo install tauri-driver --locked`).
# Linux also needs webkit2gtk-driver and xvfb. Windows needs msedgedriver on PATH.
# Usage: e2e.sh [build|test]   Default runs both. CI on Windows runs `test` at medium integrity.
# Environment variables:
#   SKIP_INSTALL=1   Skip npm ci.
set -euo pipefail
cd "$(dirname "$0")/../.."
MODE="${1:-all}"
if [ "$MODE" != "test" ]; then
  [ "${SKIP_INSTALL:-0}" = "1" ] || npm ci
  npx tauri build --no-bundle --features probe --config src-tauri/tauri.probe.conf.json
fi
[ "$MODE" = "build" ] && exit 0
if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  xvfb-run -a node --test e2e/probe.test.mjs
else
  node --test e2e/probe.test.mjs
fi

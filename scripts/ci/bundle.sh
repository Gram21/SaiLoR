#!/usr/bin/env bash
# Rust tests, installer bundle and a probe run in this system's WebView.
# Needs Node.js, Rust and (on Linux) the libraries from linux-deps.sh plus xvfb.
# Environment variables:
#   SKIP_INSTALL=1   Skip npm ci.
#   REPORT           Probe report path. Default: $TMPDIR/probe-report.txt
set -euo pipefail
cd "$(dirname "$0")/../.."
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

[ "${SKIP_INSTALL:-0}" = "1" ] || { step "npm ci"; npm ci; }

step "Rust tests"
cargo test --manifest-path src-tauri/Cargo.toml

step "Build (installer bundle)"
npx tauri build

step "Installer sizes"
find src-tauri/target/release/bundle -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*.exe' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) -exec ls -l {} \;

step "Build probe"
npx tauri build --no-bundle --features probe --config src-tauri/tauri.probe.conf.json

step "Run probe (open project, traversal check, render PDF)"
export SAILOR_PROBE_PROJECT="$PWD/samples/project.example.json"
export SAILOR_PROBE_REPORT="${REPORT:-${TMPDIR:-/tmp}/probe-report.txt}"
rm -f "$SAILOR_PROBE_REPORT"
BIN=src-tauri/target/release/sailor
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  xvfb-run -a "$BIN" > /dev/null 2>&1 &
else
  "$BIN" > /dev/null 2>&1 &
fi
PID=$!
for _ in $(seq 1 60); do
  grep -qE "RENDER OK|PDF ERROR|RENDER ERROR" "$SAILOR_PROBE_REPORT" 2>/dev/null && break
  sleep 1
done
kill "$PID" 2>/dev/null || true
echo "---- report ----"
cat "$SAILOR_PROBE_REPORT" || true
grep -q "RENDER OK" "$SAILOR_PROBE_REPORT"
grep -q -- "-> 403" "$SAILOR_PROBE_REPORT"
step "Bundle and probe passed"

#!/usr/bin/env bash
# Check dependencies for known advisories. Usage: audit.sh npm|cargo
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:-}" in
  npm) npm audit --omit=dev --audit-level=high ;;
  cargo) cargo audit --file src-tauri/Cargo.lock ;;
  *) echo "usage: $0 npm|cargo" >&2; exit 2 ;;
esac

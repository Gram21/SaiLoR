#!/usr/bin/env bash
# Lint the Tauri shell: rustfmt and clippy. Needs Rust with clippy and rustfmt.
set -euo pipefail
cd "$(dirname "$0")/../../src-tauri"
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings

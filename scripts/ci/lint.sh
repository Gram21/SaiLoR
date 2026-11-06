#!/usr/bin/env bash
# Lint workflows, shell scripts and Dockerfiles. Needs actionlint, shellcheck and hadolint on PATH.
set -euo pipefail
cd "$(dirname "$0")/../.."
actionlint
shellcheck scripts/*.sh scripts/ci/*.sh docker/*.sh
hadolint Dockerfile.tauri-linux Dockerfile.tauri-linux-gui

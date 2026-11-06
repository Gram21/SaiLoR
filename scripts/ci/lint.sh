#!/usr/bin/env bash
# Lint workflows, shell scripts and Dockerfiles. Needs actionlint, shellcheck and hadolint on PATH.
set -euo pipefail
cd "$(dirname "$0")/../.."
rc=0
actionlint || rc=1
shellcheck scripts/*.sh scripts/ci/*.sh docker/*.sh || rc=1
hadolint Dockerfile.tauri-linux Dockerfile.tauri-linux-gui || rc=1
exit $rc

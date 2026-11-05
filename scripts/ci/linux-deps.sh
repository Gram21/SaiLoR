#!/usr/bin/env bash
# Install the system libraries Tauri needs on Debian or Ubuntu.
# Usage: scripts/ci/linux-deps.sh [extra apt packages...]
# Example: scripts/ci/linux-deps.sh xvfb webkit2gtk-driver
set -euo pipefail
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
$SUDO apt-get update
$SUDO apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev "$@"

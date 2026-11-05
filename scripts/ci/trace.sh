#!/usr/bin/env bash
# Requirement trace links (OpenFastTrace). Needs Python 3, Java 17+, make and curl.
# Reports go to .cache/oft/trace.*
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -B scripts/oft/selftest.py
python3 -B scripts/oft/convert-requirements.py
make trace

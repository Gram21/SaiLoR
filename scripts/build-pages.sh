#!/usr/bin/env bash
#
# Assembles the GitHub Pages site into ./_site/.
#
# _site/ is the contents of site/ with the online demo copied to _site/demo/.
# The demo must already be built into dist-demo/ (npm run build:demo).
#
#     npm run build:demo
#     ./scripts/build-pages.sh
#     node scripts/check-site-links.js _site
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f dist-demo/index.html ]; then
  echo "dist-demo/index.html is missing. Run 'npm run build:demo' first." >&2
  exit 1
fi

rm -rf _site
mkdir _site
cp -R site/. _site/
mkdir _site/demo
cp -R dist-demo/. _site/demo/

echo "Assembled _site/ with the demo under _site/demo/."

#!/usr/bin/env bash
# Builds the GitHub Pages site into _site/: site/ plus the online demo under demo/.
# Needs Node.js and npm. Runs the demo build, so run `npm ci` first.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm run build:demo

if [ ! -f dist-demo/index.html ]; then
  echo "dist-demo/index.html is missing after npm run build:demo." >&2
  exit 1
fi

rm -rf _site
mkdir _site
cp -R site/. _site/
mkdir _site/demo
cp -R dist-demo/. _site/demo/

node scripts/check-site-links.js _site

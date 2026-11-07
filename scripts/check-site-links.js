#!/usr/bin/env node
/**
 * Checks the relative links, images, and fragments of the project site's HTML pages.
 *
 * The site (site/, published with .github/workflows/pages.yml) has no build step, so
 * a missing image or a broken page link would ship unnoticed. This script is that check.
 *
 * For each *.html file under the root it verifies:
 *   1. Every relative href/src points at a file that exists (a directory means its index.html).
 *      A "?query" is ignored, so "./demo/?mode=schema" checks "./demo/".
 *   2. Every "#fragment" points at an id that exists in the target page.
 * Absolute URLs (https:, mailto:, ...) are not fetched.
 *
 * Links into demo/ are only checked when the root contains demo/. The demo is copied in
 * during deployment, so run the check on the assembled _site/ to verify those links.
 *
 *     npm run check:site                       # checks site/
 *     node scripts/check-site-links.js _site   # checks the assembled site, including demo/
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? 'site')
const linkPattern = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const idPattern = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const schemePattern = /^[a-z][a-z0-9+.-]*:/i
const demoDir = join(root, 'demo')

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return htmlFiles(path)
    return entry.name.endsWith('.html') ? [path] : []
  })
}

function attributeValues(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? '')
}

const idCache = new Map()
function idsOf(file) {
  if (!idCache.has(file)) {
    idCache.set(file, new Set(attributeValues(readFileSync(file, 'utf8'), idPattern)))
  }
  return idCache.get(file)
}

function resolveTarget(page, pathPart) {
  let decoded
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return null
  }
  let target = resolve(dirname(page), decoded)
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, 'index.html')
  }
  return target
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`Site root not found: ${root}`)
  process.exit(1)
}

const pages = htmlFiles(root)
if (pages.length === 0) {
  console.error(`No HTML pages found under ${root}`)
  process.exit(1)
}

const errors = []
let checked = 0
let skippedDemo = 0

for (const page of pages) {
  const text = readFileSync(page, 'utf8')
  const relPage = page.slice(root.length + 1)
  for (const raw of attributeValues(text, linkPattern)) {
    const link = raw.trim()
    if (link === '' || link.startsWith('//') || schemePattern.test(link)) continue

    const hashAt = link.indexOf('#')
    const withoutFragment = hashAt === -1 ? link : link.slice(0, hashAt)
    const fragment = hashAt === -1 ? '' : link.slice(hashAt + 1)
    const queryAt = withoutFragment.indexOf('?')
    const pathPart = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt)

    const target = pathPart === '' ? page : resolveTarget(page, pathPart)
    if (target === null) {
      errors.push(`${relPage}: ${link} -> malformed URL encoding`)
      continue
    }
    const isDemoLink = target === demoDir || target.startsWith(demoDir + sep)
    if (isDemoLink && !existsSync(demoDir)) {
      skippedDemo += 1
      continue
    }

    if (!existsSync(target)) {
      errors.push(`${relPage}: ${link} -> file not found`)
      continue
    }
    checked += 1

    if (fragment !== '' && target.endsWith('.html') && !idsOf(target).has(fragment)) {
      errors.push(`${relPage}: ${link} -> no element with id "${fragment}"`)
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  console.error(`\n${errors.length} broken link(s) found in ${pages.length} page(s).`)
  process.exit(1)
}

const skipNote = skippedDemo > 0 ? ` (${skippedDemo} demo/ link(s) skipped: no demo/ in ${root})` : ''
console.log(`OK: ${checked} relative link(s) resolve in ${pages.length} page(s)${skipNote}.`)

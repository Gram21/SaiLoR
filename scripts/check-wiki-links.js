#!/usr/bin/env node
/**
 * Checks the internal links of the wiki pages in openwiki/.
 *
 * These pages are published to the GitHub wiki (see .github/workflows/wiki-publish.yml),
 * where a link to a page or a heading that no longer exists is a dead end and nothing
 * catches it — the wiki has no build step. This script is that build step.
 *
 * It verifies three things:
 *   1. Every internal link points at a page that exists.
 *   2. Every "#section" link points at a heading that exists, using GitHub's own
 *      anchor-slug rules (including the -1, -2 suffixes it adds to duplicate headings).
 *   3. Every page is reachable from _Sidebar.md — the navigation is hand-maintained,
 *      so a new page is otherwise trivially easy to leave orphaned. `index.md` — OKF's
 *      own directory listing, deliberately not mirrored to the wiki — is exempt.
 *
 *     npm run check:wiki
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const DIR = 'openwiki'
// GitHub renders these as wiki chrome rather than as pages of their own, so they are
// not expected to appear in the sidebar's list of pages.
const CHROME = new Set(['Home', '_Sidebar', '_Footer'])
// `index.md` is OKF's own directory listing (see the frontmatter-stripping comment
// below) — it is deliberately never mirrored to the GitHub wiki (wiki-publish.yml),
// because Home.md + _Sidebar.md already are the hand-curated equivalent for that
// audience. It is not "chrome" in the CHROME sense above (GitHub gives it no special
// treatment; the exclusion is entirely our own choice), so it gets its own exemption
// from the sidebar-reachability check rather than being folded into that set.
const OKF_UNPUBLISHED = new Set(['index'])

/**
 * GitHub's heading → anchor rule: lowercase, drop anything that is not a word
 * character, whitespace or hyphen, then turn whitespace into hyphens. Note what this
 * does to "Load → Normalize": the arrow vanishes but its spaces do not, leaving a
 * double hyphen. Getting that wrong is exactly the kind of near-miss this script exists
 * to catch, so the rule is reproduced rather than approximated.
 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-')
}

/**
 * OpenWiki (the generator behind openwiki/, see .github/workflows/openwiki.yml) writes
 * its pages in Google's Open Knowledge Format, which prepends a `---`-delimited YAML
 * frontmatter block (type/title/description/tags/timestamp) to each file. GitHub's wiki
 * renderer (gollum) has no concept of frontmatter, so an unstripped block would render
 * as literal text at the top of the page — this is why wiki-publish.yml strips it before
 * copying, and why it must be stripped here too, before either scan below, so a
 * frontmatter line is never mistaken for a heading or a link. Not every page is
 * guaranteed to have one (a hand-edited page round-tripped through the wiki loses it —
 * see operations.md's "Wiki sync" section), so this is a no-op when absent.
 */
function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return m ? text.slice(m[0].length) : text
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.md'))
const pages = new Map() // page name → { anchors: Set, text }

for (const file of files) {
  const name = basename(file, '.md')
  const text = stripFrontmatter(readFileSync(join(DIR, file), 'utf-8'))
  const anchors = new Set()
  const seen = new Map()

  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line)
    if (!m) continue
    const base = slug(m[1])
    // GitHub disambiguates repeated headings with -1, -2, … in document order.
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    anchors.add(n === 0 ? base : `${base}-${n}`)
  }
  pages.set(name, { anchors, text })
}

const problems = []

for (const [name, { text }] of pages) {
  // Markdown links and images: ](target). Reference-style links are not used here.
  for (const [, target] of text.matchAll(/]\(([^)\s]+)[^)]*\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue // external — not ours to verify

    const [rawPage, anchor] = target.split('#')
    // A bare "#section" is a link within the same page. Pages are linked either as
    // "operations" (the wiki form) or "operations.md" (which also renders in the repo);
    // both name the same file.
    const targetPage = rawPage === '' ? name : rawPage.replace(/\.md$/, '')

    const page = pages.get(targetPage)
    if (!page) {
      problems.push(`${name}.md → [${target}] — no such page in ${DIR}/`)
      continue
    }
    if (anchor && !page.anchors.has(anchor)) {
      problems.push(
        `${name}.md → [${target}] — "${targetPage}" has no heading with anchor "#${anchor}"`,
      )
    }
  }
}

// Orphan check: the sidebar is the wiki's only navigation, and it is hand-written.
const sidebar = pages.get('_Sidebar')
if (!sidebar) {
  problems.push('_Sidebar.md is missing — the wiki would have no navigation')
} else {
  for (const name of pages.keys()) {
    if (CHROME.has(name) || OKF_UNPUBLISHED.has(name)) continue
    const linked = new RegExp(`]\\(${name}(\\.md)?([#)])`).test(sidebar.text)
    if (!linked) {
      problems.push(`_Sidebar.md does not link to "${name}" — the page would be orphaned`)
    }
  }
}

const pageCount = [...pages.keys()].filter(
  (p) => !CHROME.has(p) && !OKF_UNPUBLISHED.has(p),
).length
if (problems.length > 0) {
  console.error(`\nBroken wiki links (${problems.length}):\n`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error(`\nChecked ${pages.size} files in ${DIR}/.\n`)
  process.exit(1)
}

console.log(`openwiki: ${pages.size} files, ${pageCount} pages — all internal links resolve.`)

#!/usr/bin/env node
/**
 * Checks the internal links of the wiki pages in openwiki/ and user-guide/.
 *
 * Both are published to the GitHub wiki (see .github/workflows/wiki-publish.yml),
 * where a link to a page, heading, or image that no longer exists is a dead end and
 * nothing catches it — the wiki has no build step. This script is that build step.
 *
 * For each directory it verifies:
 *   1. Every internal link points at a page that exists.
 *   2. Every "#section" link points at a heading that exists, using GitHub's own
 *      anchor-slug rules (including the -1, -2 suffixes it adds to duplicate headings).
 *   3. Every link to something outside a bare page name — an image, or a path leaving
 *      the directory (openwiki/../LICENSE-style) — resolves to a real file on disk.
 *   4. Every page is reachable from that directory's own table of contents (openwiki:
 *      _Sidebar.md, hand-maintained; user-guide: README.md, whose "Guide contents"
 *      table serves the same purpose) — otherwise a new page is trivially easy to leave
 *      orphaned. Each directory has a small set of files exempt from this (its own
 *      chrome, generator bookkeeping) — see the per-directory config below.
 *
 *     npm run check:wiki
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
 * see operations.md's "Wiki sync" section, and user-guide pages never have one at all),
 * so this is a no-op when absent.
 */
function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/**
 * Checks one wiki directory's pages against the four rules in the file header.
 * Returns { problems, pageCount } for that directory alone.
 */
function checkDir(dir, { tocPage, chrome, exempt }) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  const pages = new Map() // page name → { anchors: Set, text }

  for (const file of files) {
    const name = basename(file, '.md')
    const text = stripFrontmatter(readFileSync(join(dir, file), 'utf-8'))
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

      // A path — leaves the bare-page-name form, either because it names a file that
      // isn't a page here (an image) or because it steps outside this directory
      // (`../LICENSE`, `../README.md`) — is a plain file-existence check, not a page
      // lookup: neither case has an entry in `pages`, and an image has no headings to
      // anchor into anyway.
      if (rawPage !== '' && rawPage.includes('/')) {
        if (!existsSync(join(dir, rawPage))) {
          problems.push(`${dirname(join(dir, name))}/${name}.md → [${target}] — no such file`)
        }
        continue
      }

      // A bare "#section" is a link within the same page. Pages are linked either as
      // "operations" (the wiki form) or "operations.md" (which also renders in the
      // repo, and is how every user-guide cross-link is written); both name the same
      // file.
      const targetPage = rawPage === '' ? name : rawPage.replace(/\.md$/, '')

      const page = pages.get(targetPage)
      if (!page) {
        problems.push(`${dir}/${name}.md → [${target}] — no such page in ${dir}/`)
        continue
      }
      if (anchor && !page.anchors.has(anchor)) {
        problems.push(
          `${dir}/${name}.md → [${target}] — "${targetPage}" has no heading with anchor "#${anchor}"`,
        )
      }
    }

    // Every screenshot here is embedded as `<img src="...">` (for the explicit `width=`
    // gollum's markdown-image syntax has no equivalent for), not `![alt](path)` — so it
    // needs its own scan; the markdown-link regex above never sees it.
    for (const [, src] of text.matchAll(/<img\s[^>]*\bsrc="([^"]+)"/g)) {
      if (/^(https?:)/.test(src)) continue // external — not ours to verify
      if (!existsSync(join(dir, src))) {
        problems.push(`${dir}/${name}.md → <img src="${src}"> — no such file`)
      }
    }
  }

  // Orphan check: `tocPage` is the directory's only navigation, and it is hand-written.
  const toc = pages.get(tocPage)
  if (!toc) {
    problems.push(`${dir}/${tocPage}.md is missing — the section would have no navigation`)
  } else {
    for (const name of pages.keys()) {
      if (chrome.has(name) || exempt.has(name) || name === tocPage) continue
      const linked = new RegExp(`]\\(${name}(\\.md)?([#)])`).test(toc.text)
      if (!linked) {
        problems.push(`${dir}/${tocPage}.md does not link to "${name}" — the page would be orphaned`)
      }
    }
  }

  const pageCount = [...pages.keys()].filter((p) => !chrome.has(p) && !exempt.has(p)).length
  return { problems, fileCount: pages.size, pageCount }
}

const results = [
  checkDir('openwiki', {
    tocPage: '_Sidebar',
    // GitHub renders these as wiki chrome rather than as pages of their own, so they
    // are not expected to appear in the sidebar's list of pages.
    chrome: new Set(['Home', '_Sidebar', '_Footer']),
    // `index.md` is OKF's own directory listing (see the frontmatter-stripping comment
    // above) — deliberately never mirrored to the GitHub wiki (wiki-publish.yml),
    // because Home.md + _Sidebar.md already are the hand-curated equivalent for that
    // audience. `INSTRUCTIONS.md` is the shared, user-authored brief handed to the
    // OpenWiki generator itself (see .github/workflows/openwiki.yml) — config the
    // generator reads, not a page it writes for a reader. Neither is "chrome" in the
    // sense above (GitHub gives them no special treatment; the exclusion is entirely
    // our own choice), so both get their own exemption from the sidebar-reachability
    // check instead of being folded into `chrome`, which would misdescribe them.
    exempt: new Set(['index', 'INSTRUCTIONS']),
  }),
  checkDir('user-guide', {
    tocPage: 'README',
    // user-guide has no _Sidebar/_Footer/Home equivalent — README.md's own "Guide
    // contents" table is both the section's landing page and its table of contents.
    chrome: new Set(),
    exempt: new Set(),
  }),
]

const allProblems = results.flatMap((r) => r.problems)

if (allProblems.length > 0) {
  console.error(`\nBroken wiki links (${allProblems.length}):\n`)
  for (const p of allProblems) console.error(`  ✗ ${p}`)
  console.error()
  process.exit(1)
}

for (const [dir, { fileCount, pageCount }] of [
  ['openwiki', results[0]],
  ['user-guide', results[1]],
]) {
  console.log(`${dir}: ${fileCount} files, ${pageCount} pages — all internal links resolve.`)
}

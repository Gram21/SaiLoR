/**
 * Parse reference-manager exports (BibTeX / RIS / CSL-JSON) into a flat list of
 * entries for the project editor's "Import references…" flow. These files are
 * hand-edited far more often than any other input this app reads, so every
 * parser here is total: a malformed entry is skipped, and `parseReferences`
 * itself never throws — a bad file just yields fewer (or zero) entries.
 */

import { parseYear } from './year'

export interface RefEntry {
  title: string
  authors: string[]
  doi?: string
  year?: number
  /** Journal, conference/proceedings, or publisher — see `Paper.venue`. One
   *  free-text field: BibTeX journal/booktitle/publisher, RIS JF/JO/T2, and
   *  CSL container-title/publisher all collapse to "where it appeared", and
   *  no source format reliably distinguishes journal from proceedings. */
  venue?: string
  /** The abstract, when the source carried one. Screening is usually decided
   *  on title + abstract before a PDF is ever attached, so this is worth
   *  bringing in even though nothing before this feature read it. */
  abstract?: string
  /** A PDF path/filename the reference file mentioned (BibTeX `file`, RIS `L1`/`UR`), if any. */
  pdfHint?: string
}

type Format = 'bibtex' | 'ris' | 'csl-json'

/** Parse a reference file. `filename` picks the format; content-sniff as a fallback. */
export function parseReferences(text: string, filename: string): RefEntry[] {
  try {
    const stripped = stripBom(text)
    const format = detectFormat(stripped, filename)
    if (!format) return []
    switch (format) {
      case 'bibtex':
        return parseBibtex(stripped)
      case 'ris':
        return parseRis(stripped)
      case 'csl-json':
        return parseCslJson(stripped)
    }
  } catch {
    // Whatever went wrong, an import screen is not the place to throw — the
    // user just sees "no references found" and can inspect the file.
    return []
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function detectFormat(text: string, filename: string): Format | null {
  const ext = filename.toLowerCase().match(/\.(bib|ris|json)$/)?.[1]
  if (ext === 'bib') return 'bibtex'
  if (ext === 'ris') return 'ris'
  if (ext === 'json') return 'csl-json'
  return sniffFormat(text)
}

/** Used when the extension is missing or unrecognized (a renamed export, a paste-to-file). */
function sniffFormat(text: string): Format | null {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('@')) return 'bibtex'
  if (/^TY\s{0,2}-/m.test(trimmed)) return 'ris'
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'csl-json'
  return null
}

// ---------------------------------------------------------------------------
// Shared helpers: author-name and title normalization
// ---------------------------------------------------------------------------

/** "Last, First" → "First Last". Names without a comma are assumed already in that order. */
function normalizeAuthorName(raw: string): string {
  const name = raw.trim()
  if (!name) return ''
  const comma = name.indexOf(',')
  if (comma === -1) return collapseSpace(name)
  const last = name.slice(0, comma).trim()
  const rest = name.slice(comma + 1).trim()
  return collapseSpace(rest ? `${rest} ${last}` : last)
}

function collapseSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// LaTeX escapes → UTF-8
//
// BibTeX exports routinely spell non-ASCII author/title letters as LaTeX
// escapes: an accent command applied to a base letter (`\"o`, `\'e`, `\c{c}`)
// or a handful of standalone letters that are not "a letter plus an accent"
// at all (`\ss`, `\o`, `\ae`, ...). Both the accent commands and the
// standalone letters may additionally sit inside a `{...}` pair used only to
// protect capitalization (`{\"o}`), and the accent commands may brace their
// own argument (`\"{o}`) or not (`\"o`) — three shapes, same meaning. This
// function only ever looks at backslash-led sequences, so it is applied
// *before* the generic `{}`-stripping step in `cleanBibValue`: braces are
// irrelevant to it either way (they're just inert characters it steps over),
// which is what makes all three shapes fall out of one pass instead of
// needing special-casing per shape.
// ---------------------------------------------------------------------------

// Accent-command marker → base letter → accented letter. Covers the accents
// that actually show up in European author names (German/Nordic umlauts,
// Romance acutes/graves/circumflexes, Baltic macrons, Polish/Lithuanian dot-
// and ogonek-marks, Czech/Slovak carons, Turkish/Romanian breves and
// cedillas, Hungarian double acutes, Scandinavian rings).
const LATEX_ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ',
         A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü', Y: 'Ÿ' },
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý',
         A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù',
         A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û',
         A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '~': { a: 'ã', n: 'ñ', o: 'õ',
         A: 'Ã', N: 'Ñ', O: 'Õ' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū',
         A: 'Ā', E: 'Ē', I: 'Ī', O: 'Ō', U: 'Ū' },
  '.': { c: 'ċ', e: 'ė', g: 'ġ', z: 'ż',
         C: 'Ċ', E: 'Ė', G: 'Ġ', Z: 'Ż' },
  c: { c: 'ç', s: 'ş', C: 'Ç', S: 'Ş' },
  v: { c: 'č', e: 'ě', r: 'ř', s: 'š', z: 'ž',
       C: 'Č', E: 'Ě', R: 'Ř', S: 'Š', Z: 'Ž' },
  u: { a: 'ă', g: 'ğ', A: 'Ă', G: 'Ğ' },
  H: { o: 'ő', u: 'ű', O: 'Ő', U: 'Ű' },
  r: { a: 'å', u: 'ů', A: 'Å', U: 'Ů' },
  k: { a: 'ą', e: 'ę', A: 'Ą', E: 'Ę' },
}

// Letters that are not "base letter + accent" but distinct characters with
// their own command name.
const LATEX_LETTERS: Record<string, string> = {
  ss: 'ß',
  o: 'ø', O: 'Ø',
  l: 'ł', L: 'Ł',
  ae: 'æ', AE: 'Æ',
  oe: 'œ', OE: 'Œ',
  aa: 'å', AA: 'Å',
  i: 'ı', // dotless i (\i)
  j: 'ȷ', // dotless j (\j)
}

function unescapeLatex(s: string): string {
  let out = s
  // `\"o` or `\"{o}` — symbol-marker accents accept either shape.
  out = out.replace(
    /\\(["'`^~=.])(?:\{([A-Za-z])\}|([A-Za-z]))/g,
    (m, marker: string, braced: string | undefined, bare: string) =>
      LATEX_ACCENTS[marker]?.[braced ?? bare] ?? m,
  )
  // `\c{c}`, `\v{s}`, ... — letter-named accent commands. Real exports only
  // ever brace the argument here (unlike the symbol markers above); requiring
  // the brace also means these can never collide with the standalone letters
  // below, none of which start with c/v/u/H/r/k.
  out = out.replace(
    /\\([cvuHrk])\{([A-Za-z])\}/g,
    (m, marker: string, letter: string) => LATEX_ACCENTS[marker]?.[letter] ?? m,
  )
  // Standalone letters. Three shapes: an explicit `{}` terminator (`\o{}re` is
  // "øre"), bare followed by the single space that terminates it (`S\o ren` is
  // "Søren" — TeX consumes the space that ends a control word, it is not part
  // of the text), or bare followed by anything else. The negative lookahead
  // keeps `\o` from eating into a longer command it happens to prefix (e.g.
  // `\onlinecite`).
  //
  // Consuming that space is only safe because the author list is split on
  // " and " *before* this runs (see `parseBibEntry`), which is also the order
  // BibTeX itself works in: it separates names on the raw field, then each
  // name is expanded. Unescape first and the space in `Wei\ss and Hans` would
  // be eaten as `\ss`'s terminator, glueing the separator into "Weißand".
  out = out.replace(
    /\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?:\{\}| |(?![A-Za-z]))/g,
    (m, name: string) => LATEX_LETTERS[name] ?? m,
  )
  // Anything left with a backslash — a plain-punctuation escape (`\&`, `\%`,
  // `\_`, `\#`, `\$`), an escaped space (`\ ` → a space), or a command this
  // table doesn't know. Dropping just the backslash keeps the text readable
  // and never leaves a stray backslash behind, which matters more here than
  // perfectly resolving an escape we've never seen.
  out = out.replace(/\\(.)/g, '$1')
  return out
}

// ---------------------------------------------------------------------------
// Repairing author names merged by a lost " and " separator
//
// This is a heuristic, not a parser: BibTeX gives no structural signal for
// where one author's name ends and the next begins once the separator is
// gone, only capitalization. A wrong split silently corrupts a real name
// (a data-quality bug a reviewer may never notice), while a missed split
// just leaves two names glued together (ugly, but visible and easy to fix
// by hand). So every check below is a *veto*, not a trigger: we only commit
// to a split when the result looks unambiguously like two people, and
// otherwise leave the text alone.
// ---------------------------------------------------------------------------

// Prefixes where an internal capital is part of the surname itself, not a
// lost separator: McDonald, MacLeod, MacArthur, DeSilva, DiCaprio, LaSalle,
// VanDyke, DuBois. Checked against the fragment immediately before the
// lowercase→uppercase seam.
const NAME_PREFIX_ALLOWLIST = ['Mc', 'Mac', 'De', 'Di', 'La', 'Van', 'Du']

/**
 * Find a lowercase→uppercase seam inside one token that looks like two
 * merged names ("KeimAngelika") rather than a legitimate internal capital.
 * Names with an apostrophe or hyphen at the capital (O'Brien, D'Angelo,
 * Smith-Jones) never reach this at all: the seam requires the uppercase
 * letter to be *immediately* preceded by a lowercase one, and an apostrophe
 * or hyphen breaks that adjacency. All-caps surnames have no lowercase
 * letter to seam off of. That leaves only the Mc/Mac/De/... family as
 * genuine false positives, which the allowlist above covers explicitly.
 */
function findMergeSeam(token: string): [string, string] | null {
  const m = /^(.*?[a-z])([A-Z].*)$/.exec(token)
  if (!m) return null
  const [, left, right] = m
  if (NAME_PREFIX_ALLOWLIST.includes(left)) return null
  if (left.length < 2 || right.length < 2) return null
  return [left, right]
}

/**
 * A token ending in a bare "and" is either a real name (Roland, Armand,
 * Bertrand, Durand, Ferdinand...) or "someone" + a separator "and" that lost
 * its leading space — nothing in the token itself can tell them apart. The
 * caller (`repairMergedAuthorNames`) resolves that ambiguity the same way it
 * resolves the no-"and"-at-all case: only commit if the surrounding split
 * yields two multi-token names, which a genuine single name essentially
 * never does (a lone "Roland" leaves only a one-token remainder after it).
 */
function endsInBareAnd(token: string): string | null {
  const m = /^([A-Z][A-Za-z'-]*)and$/.exec(token)
  return m ? m[1] : null
}

/**
 * One "and"-split chunk that should be exactly one author. Detects the two
 * ways a lost separator can still be hiding in it — a token merely missing
 * the separator's leading space ("Keimand Angelika"), or a full merge with
 * no separator left at all ("KeimAngelika") — and splits into two only when
 * doing so produces two plausible "First Last"-shaped names on both sides.
 */
function repairMergedAuthorNames(chunk: string): string[] {
  const tokens = chunk.split(/\s+/).filter(Boolean)

  for (let i = 0; i < tokens.length; i++) {
    const left = endsInBareAnd(tokens[i])
    if (!left) continue
    const name1 = [...tokens.slice(0, i), left]
    const name2 = tokens.slice(i + 1)
    if (name1.length >= 2 && name2.length >= 2 && /^[A-Z]/.test(name2[0])) {
      return [name1.join(' '), name2.join(' ')]
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const seam = findMergeSeam(tokens[i])
    if (!seam) continue
    const [left, right] = seam
    const name1 = [...tokens.slice(0, i), left]
    const name2 = [right, ...tokens.slice(i + 1)]
    if (name1.length >= 2 && name2.length >= 2) {
      return [name1.join(' '), name2.join(' ')]
    }
  }

  return [chunk]
}

/** Split a BibTeX author field into individual author strings, repairing a
 *  lost/mangled " and " separator before and after the ordinary split. */
function splitAuthorList(raw: string): string[] {
  // "andAngelika" — the separator kept its word but lost its trailing space.
  // Unconditionally safe: a capital letter directly glued onto "and" with no
  // space never occurs in real prose or names, only in this exact bug.
  const spaced = raw.replace(/\band([A-Z])/g, 'and $1')
  return spaced.split(/\s+and\s+/i).flatMap(repairMergedAuthorNames)
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

/**
 * Split the file into individual `@type{...}` entry bodies, tracking brace
 * depth so a value like `{The {DNA} Structure}` doesn't end the entry early.
 * `@comment`/`@string`/`@preamble` blocks are skipped (still brace-matched, so
 * they don't confuse the scan of what follows).
 */
function splitBibEntries(text: string): string[] {
  const entries: string[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const at = text.indexOf('@', i)
    if (at === -1) break
    let j = at + 1
    while (j < n && /[A-Za-z]/.test(text[j])) j++
    const type = text.slice(at + 1, j).toLowerCase()
    while (j < n && /\s/.test(text[j])) j++
    const open = text[j]
    if (open !== '{' && open !== '(') {
      i = at + 1
      continue
    }
    const close = open === '{' ? '}' : ')'
    let depth = 1
    let k = j + 1
    while (k < n && depth > 0) {
      if (text[k] === open) depth++
      else if (text[k] === close) depth--
      k++
    }

    // Ran to the end without closing: this entry has an unbalanced brace. One
    // stray `{` — a hand-edit, a LaTeX-heavy abstract — used to consume the
    // rest of the file, so a 500-entry export whose third entry was malformed
    // silently imported three papers. That directly contradicts this module's
    // contract that a malformed entry is *skipped*, and the failure is
    // invisible: no error, just a short list.
    //
    // Resync instead: give up on this entry and resume from the next `@` that
    // starts a line, which is where a well-formed file puts them.
    if (depth > 0) {
      const resync = text.slice(at + 1).search(/(?:^|\n)[ \t]*@/)
      if (resync === -1) break
      // `search` is relative to at+1, and its match may include the newline.
      const abs = at + 1 + resync
      i = text[abs] === '@' ? abs : abs + 1
      continue
    }

    if (type && type !== 'comment' && type !== 'string' && type !== 'preamble') {
      entries.push(text.slice(at, k))
    }
    i = k > at + 1 ? k : at + 1
  }
  return entries
}

/** Split `s` on top-level occurrences of `sep` — not inside `{...}` or `"..."`. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuotes = false
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' && s[i - 1] !== '\\' && depth === 0) {
      inQuotes = !inQuotes
    } else if (!inQuotes) {
      if (c === '{') depth++
      else if (c === '}') depth = Math.max(0, depth - 1)
      else if (c === sep && depth === 0) {
        parts.push(s.slice(start, i))
        start = i + 1
      }
    }
  }
  parts.push(s.slice(start))
  return parts
}

/** Strip one layer of `{...}`/`"..."` wrapping. Shared by `cleanBibValue` and
 *  `cleanBibPathSegment` — everything past this point diverges. */
function unwrapBibValue(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('{') && v.endsWith('}')) return v.slice(1, -1)
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  return v
}

/** Clean a BibTeX text value (title, author list, doi, year): unescape LaTeX
 *  *before* dropping braces — `{\"o}` and `\"{o}` both rely on the braces
 *  still being there when `unescapeLatex` runs, and are gone by the time the
 *  generic `[{}]` strip below runs (which still exists for capitalization
 *  braces that don't wrap an escape at all, e.g. `{DNA}`). */
function cleanBibValue(raw: string): string {
  return unescapeLatex(unwrapBibValue(raw))
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Clean a BibTeX value that is a filesystem path/URL rather than text, e.g.
 *  the `file` field. Deliberately *not* `cleanBibValue`: a Windows path like
 *  `C:\Users\name\file.pdf` is full of backslashes that `unescapeLatex`'s
 *  catch-all fallback would strip as "unknown escapes", mangling the path.
 *  Keeps only the narrow punctuation/space unescaping paths can legitimately
 *  contain. */
function cleanBibPathSegment(raw: string): string {
  return unwrapBibValue(raw)
    .replace(/[{}]/g, '')
    .replace(/\\([&%_#$])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseBibFields(body: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const raw of splitTopLevel(body, ',')) {
    const eq = raw.indexOf('=')
    if (eq === -1) continue // not a field (e.g. trailing comma, or malformed)
    const name = raw.slice(0, eq).trim().toLowerCase()
    const value = raw.slice(eq + 1)
    if (!name) continue
    fields.set(name, value)
  }
  return fields
}

/** BibTeX `file = {...}` is exported by Zotero/Mendeley as one or more
 *  `;`-separated "description:path:mimetype" triples (colons inside a path
 *  are backslash-escaped). Take the path segment of the first one. */
function extractBibFileHint(raw: string): string | undefined {
  const first = cleanBibPathSegment(raw.split(';')[0] ?? '')
  if (!first) return undefined
  const parts = first.split(/(?<!\\):/).map((p) => p.replace(/\\:/g, ':').trim())
  const candidate = parts.length >= 2 ? parts[1] : parts[0]
  return candidate || undefined
}

function parseBibEntry(raw: string): RefEntry | null {
  const head = raw.match(/^@([A-Za-z]+)\s*[{(]/)
  if (!head) return null
  const body = raw.slice(head[0].length, -1) // drop the matching closing brace/paren
  // The first top-level comma separates the citation key from its fields; an
  // entry with none (broken/empty) simply has no fields to find.
  const parts = splitTopLevel(body, ',')
  const fieldsStr = parts.length > 1 ? body.slice(parts[0].length + 1) : ''
  const fields = parseBibFields(fieldsStr)

  const title = fields.has('title') ? cleanBibValue(fields.get('title')!) : ''
  if (!title) return null // no title, nothing worth importing

  const entry: RefEntry = { title, authors: [] }
  if (fields.has('author')) {
    // Split the *raw* list on " and " before cleaning each name, which is the
    // order BibTeX itself works in — the separator is a property of the field,
    // not of any one name. Cleaning first would let a name-final control word
    // (`Wei\ss and Hans`) swallow the separator's space; see `unescapeLatex`.
    entry.authors = splitAuthorList(unwrapBibValue(fields.get('author')!))
      .map((name) => normalizeAuthorName(cleanBibValue(name)))
      .filter(Boolean)
  }
  if (fields.has('doi')) {
    const doi = cleanBibValue(fields.get('doi')!)
    if (doi) entry.doi = doi
  }
  if (fields.has('year')) {
    entry.year = parseYear(cleanBibValue(fields.get('year')!))
  }
  // journal (article) / journaltitle (biblatex's own name for the same thing)
  // / booktitle (a chapter or a conference paper) / publisher (last resort,
  // e.g. a standalone report) — first non-empty wins. Not a merge: a BibTeX
  // entry realistically only ever has one of these, so there is no tag-order
  // question here the way there is for RIS's JF/JO/T2 below.
  for (const key of ['journal', 'journaltitle', 'booktitle', 'publisher']) {
    if (!fields.has(key)) continue
    const venue = cleanBibValue(fields.get(key)!)
    if (venue) {
      entry.venue = venue
      break
    }
  }
  if (fields.has('file')) {
    const hint = extractBibFileHint(fields.get('file')!)
    if (hint) entry.pdfHint = hint
  }
  if (fields.has('abstract')) {
    const abstract = cleanBibValue(fields.get('abstract')!)
    if (abstract) entry.abstract = abstract
  }
  return entry
}

function parseBibtex(text: string): RefEntry[] {
  const out: RefEntry[] = []
  for (const raw of splitBibEntries(text)) {
    try {
      const entry = parseBibEntry(raw)
      if (entry) out.push(entry)
    } catch {
      // One malformed entry must not take the rest of the file down.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

interface RisDraft {
  title?: string
  authors: string[]
  doi?: string
  year?: number
  /** From `N2` — kept separately from `abstractAB` so a later `AB` can still
   *  win regardless of tag order (see `finalizeRis`). */
  abstract?: string
  /** From `AB`, the primary abstract tag. */
  abstractAB?: string
  /** From `JF` (journal, full title) — RIS's primary venue tag. Draft fields
   *  kept separately per tag, same as the abstract pair above, so the
   *  precedence in `finalizeRis` is independent of which tag the exporter
   *  happened to write first. */
  venueJF?: string
  /** From `JO` (journal, abbreviated). */
  venueJO?: string
  /** From `T2` (secondary title — journal for an article, or the
   *  proceedings/book title for a conference paper or chapter). */
  venueT2?: string
  pdfHint?: string
}

function finalizeRis(cur: RisDraft): RefEntry | null {
  const title = cur.title?.trim()
  if (!title) return null
  return {
    title,
    authors: cur.authors,
    doi: cur.doi,
    year: cur.year,
    // AB is RIS's primary abstract tag; N2 is a widely-used alternate some
    // exporters use instead (or, less often, alongside it). Prefer AB over
    // N2 rather than concatenating — they are read as alternates in the
    // wild, and concatenating would risk a duplicated abstract.
    abstract: cur.abstractAB ?? cur.abstract,
    // JF (full journal title) is the most specific and most common; JO is a
    // same-meaning abbreviation some exporters use instead; T2 is the
    // catch-all "secondary title" RIS reuses for a conference/book title when
    // there is no journal at all. First non-empty of that priority wins,
    // computed here rather than by an `if (!cur.x)` first-wins guard while
    // scanning — a guard like that would let tag order decide the winner
    // instead of the tag's own meaning, exactly the bug the abstract pair
    // above is already written to avoid.
    venue: cur.venueJF ?? cur.venueJO ?? cur.venueT2,
    pdfHint: cur.pdfHint,
  }
}

/**
 * Append a wrapped continuation line to the value it continues.
 *
 * Only the prose fields wrap in practice, and only they are safe to join: an
 * identifier or a path (DO, L1, UR) that appeared to wrap would more likely be
 * a malformed file than a long value, and gluing a stray line onto a DOI would
 * quietly corrupt it. Authors are excluded too — RIS gives one author per line,
 * so a line following AU is a new name, not a continuation of the last one.
 */
function appendRis(cur: RisDraft, tag: string, cont: string): void {
  const text = collapseSpace(unescapeLatex(cont))
  if (!text) return
  if ((tag === 'TI' || tag === 'T1') && cur.title) cur.title = `${cur.title} ${text}`
  else if (tag === 'AB' && cur.abstractAB) cur.abstractAB = `${cur.abstractAB} ${text}`
  else if (tag === 'N2' && cur.abstract) cur.abstract = `${cur.abstract} ${text}`
}

function parseRis(text: string): RefEntry[] {
  const lines = text.split(/\r\n|\r|\n/)
  const records: RefEntry[] = []
  let cur: RisDraft | null = null

  // The tag whose value a continuation line belongs to. RIS wraps long values
  // onto following lines with no tag of their own, and dropping them truncated
  // a wrapped title mid-sentence — which then also changed how duplicate
  // detection scored it.
  let lastTag: string | null = null

  for (const rawLine of lines) {
    const m = rawLine.match(/^([A-Za-z][A-Za-z0-9])\s{0,2}-\s?(.*)$/)
    if (!m) {
      const cont = rawLine.trim()
      if (cur && lastTag && cont) appendRis(cur, lastTag, cont)
      continue
    }
    const tag = m[1].toUpperCase()
    const value = m[2].trim()
    lastTag = tag

    if (tag === 'TY') {
      // A new record starts here, so whatever was in progress ends here —
      // finalize it rather than dropping it on the floor. Files with no `ER`
      // lines exist (hand-edited, truncated, or written by a sloppy exporter),
      // and overwriting `cur` meant every record but the *last* vanished with
      // no error: three records in, one out. The trailing-record rescue at the
      // bottom of this function already recognised the same problem; this is
      // the same rescue for the records before it.
      if (cur) {
        const prev = finalizeRis(cur)
        if (prev) records.push(prev)
      }
      cur = { authors: [] }
      continue
    }
    if (!cur) continue // a field before any TY — nothing to attach it to
    if (tag === 'ER') {
      const entry = finalizeRis(cur)
      if (entry) records.push(entry)
      cur = null
      continue
    }
    switch (tag) {
      // RIS is plain text like BibTeX and can carry the same LaTeX escapes
      // (a common source is a .bib file round-tripped through a converter),
      // so title/author get the same unescape — but not DO/L1/UR below,
      // which are identifiers and paths, not prose.
      case 'TI':
      case 'T1':
        if (!cur.title && value) cur.title = collapseSpace(unescapeLatex(value))
        break
      case 'AU':
      case 'A1':
        // RIS already gives one author per AU/A1 line, so the merged-name
        // repair that BibTeX needs (see splitAuthorList) doesn't apply here.
        if (value) cur.authors.push(normalizeAuthorName(unescapeLatex(value)))
        break
      case 'DO':
        if (value) cur.doi = value
        break
      case 'PY':
      case 'Y1': {
        if (cur.year === undefined) {
          const y = parseYear(value)
          if (y !== undefined) cur.year = y
        }
        break
      }
      case 'AB':
        if (value) cur.abstractAB = collapseSpace(unescapeLatex(value))
        break
      case 'N2':
        if (!cur.abstract && value) cur.abstract = collapseSpace(unescapeLatex(value))
        break
      case 'JF':
        if (value) cur.venueJF = collapseSpace(unescapeLatex(value))
        break
      case 'JO':
        if (value) cur.venueJO = collapseSpace(unescapeLatex(value))
        break
      case 'T2':
        if (value) cur.venueT2 = collapseSpace(unescapeLatex(value))
        break
      case 'L1':
        if (!cur.pdfHint && value) cur.pdfHint = value
        break
      case 'UR':
        if (!cur.pdfHint && /\.pdf$/i.test(value)) cur.pdfHint = value
        break
      default:
        break
    }
  }
  // A record with no trailing `ER  -` (a truncated/hand-edited file) is still
  // worth keeping rather than silently dropping the last entry.
  if (cur) {
    const entry = finalizeRis(cur)
    if (entry) records.push(entry)
  }
  return records
}

// ---------------------------------------------------------------------------
// CSL-JSON (Zotero's native export)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parseCslItem(raw: unknown): RefEntry | null {
  if (!isRecord(raw)) return null
  const title = typeof raw.title === 'string' ? collapseSpace(raw.title) : ''
  if (!title) return null

  const authors: string[] = []
  if (Array.isArray(raw.author)) {
    for (const a of raw.author) {
      if (!isRecord(a)) continue
      if (typeof a.literal === 'string' && a.literal.trim()) {
        authors.push(collapseSpace(a.literal))
        continue
      }
      const given = typeof a.given === 'string' ? a.given.trim() : ''
      const family = typeof a.family === 'string' ? a.family.trim() : ''
      const full = collapseSpace(`${given} ${family}`)
      if (full) authors.push(full)
    }
  }

  const doi = typeof raw.DOI === 'string' && raw.DOI.trim() ? raw.DOI.trim() : undefined
  const abstract = typeof raw.abstract === 'string' && raw.abstract.trim() ? collapseSpace(raw.abstract) : undefined
  // `container-title` is the journal/proceedings/book a CSL item appeared in;
  // `publisher` is what is left for an item type (e.g. a standalone report)
  // that has no container at all.
  const venue =
    (typeof raw['container-title'] === 'string' && collapseSpace(raw['container-title'])) ||
    (typeof raw.publisher === 'string' && collapseSpace(raw.publisher)) ||
    undefined

  let year: number | undefined
  const issued = raw.issued
  if (isRecord(issued) && Array.isArray(issued['date-parts'])) {
    const first = issued['date-parts'][0]
    if (Array.isArray(first)) year = parseYear(first[0])
  }

  return { title, authors, doi, year, venue, abstract }
}

function parseCslJson(text: string): RefEntry[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const items = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.items)
      ? data.items
      : null
  if (!items) return []

  const out: RefEntry[] = []
  for (const raw of items) {
    try {
      const entry = parseCslItem(raw)
      if (entry) out.push(entry)
    } catch {
      // One malformed item must not take the rest of the file down.
    }
  }
  return out
}

/** The file name a hinted PDF path/URL suggests, for a placeholder `pdf` value. */
export function pdfHintFileName(hint: string): string {
  return hint.split(/[\\/]/).pop() || hint
}

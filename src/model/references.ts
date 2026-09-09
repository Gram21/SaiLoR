/**
 * Parse reference-manager exports (BibTeX / RIS / CSL-JSON) for the "Import
 * references…" flow. These files are hand-edited often, so every parser here
 * is total: a malformed entry is skipped, `parseReferences` never throws.
 */

import { parseYear } from './year'

export interface RefEntry {
  title: string
  authors: string[]
  doi?: string
  year?: number
  /** Journal, conference/proceedings, or publisher — see `Paper.venue`. No
   *  source format reliably distinguishes journal from proceedings, so this
   *  collapses BibTeX journal/booktitle/publisher, RIS JF/JO/T2, and CSL
   *  container-title/publisher into one free-text field. */
  venue?: string
  /** The abstract, when the source carried one — screening is usually
   *  decided on title + abstract before a PDF is attached. */
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
    // An import screen shouldn't throw — just yield no references.
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
// BibTeX spells non-ASCII letters as accent commands (`\"o`, `\c{c}`) or
// standalone letter commands (`\ss`, `\o`, `\ae`...), either possibly wrapped
// in a capitalization-protecting `{...}` and/or bracing their own argument
// (`\"{o}` vs `\"o`) — three shapes, same meaning. This only looks at
// backslash-led sequences and runs *before* `cleanBibValue`'s brace-stripping,
// since braces are just inert characters it steps over — one pass handles
// all three shapes with no special-casing.
// ---------------------------------------------------------------------------

// Accent-command marker → base letter → accented letter (covers the accents
// used in European author names).
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

// Letters that are distinct characters with their own command name, not
// "base letter + accent".
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
  // `\c{c}`, `\v{s}`, ... — letter-named accent commands. Real exports always
  // brace the argument; requiring it also keeps these from colliding with the
  // standalone letters below (none start with c/v/u/H/r/k).
  out = out.replace(
    /\\([cvuHrk])\{([A-Za-z])\}/g,
    (m, marker: string, letter: string) => LATEX_ACCENTS[marker]?.[letter] ?? m,
  )
  // Standalone letters: `{}`-terminated, bare + the single space TeX consumes
  // as the control word's terminator (`S\o ren` → "Søren"), or bare + anything
  // else. Negative lookahead stops `\o` from eating into `\onlinecite` etc.
  // Consuming that space is only safe because the author list is already
  // split on " and " before this runs (see `parseBibEntry`) — unescaping
  // first would let `Wei\ss and Hans` eat the separator's space as `\ss`'s
  // terminator, glueing it into "Weißand".
  out = out.replace(
    /\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?:\{\}| |(?![A-Za-z]))/g,
    (m, name: string) => LATEX_LETTERS[name] ?? m,
  )
  // Anything left with a backslash (plain-punctuation escapes, `\ ` → space,
  // or an unknown command) — just drop the backslash rather than try to
  // resolve an escape we've never seen.
  out = out.replace(/\\(.)/g, '$1')
  return out
}

// ---------------------------------------------------------------------------
// Repairing author names merged by a lost " and " separator
//
// Heuristic, not a parser: BibTeX gives no structural signal for where one
// name ends and the next begins once the separator is gone, only
// capitalization. A wrong split silently corrupts a name, while a missed
// split just leaves two names glued together (visible, easy to fix by hand).
// So every check below is a *veto*: only commit to a split when it
// unambiguously looks like two people.
// ---------------------------------------------------------------------------

// Prefixes where an internal capital is part of the surname itself, not a
// lost separator (McDonald, MacLeod, DeSilva, DiCaprio, LaSalle, VanDyke,
// DuBois), checked against the fragment before the lowercase→uppercase seam.
const NAME_PREFIX_ALLOWLIST = ['Mc', 'Mac', 'De', 'Di', 'La', 'Van', 'Du']

/**
 * Find a lowercase→uppercase seam inside one token that looks like two
 * merged names ("KeimAngelika") rather than a legitimate internal capital
 * (O'Brien, Smith-Jones, and ALL-CAPS never match; Mc/Mac/... is vetoed via
 * the allowlist above).
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
 * A token ending in a bare "and" is either a real name (Roland, Armand...)
 * or a name + separator "and" that lost its leading space — nothing in the
 * token itself can tell them apart. The caller only commits to the split if
 * it yields two multi-token names, which a genuine single name won't.
 */
function endsInBareAnd(token: string): string | null {
  const m = /^([A-Z][A-Za-z'-]*)and$/.exec(token)
  return m ? m[1] : null
}

/**
 * One "and"-split chunk that should be exactly one author. Detects a lost
 * separator hiding as a missing leading space ("Keimand Angelika") or a full
 * merge ("KeimAngelika"), splitting only when both sides look like plausible
 * "First Last" names.
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
  // "andAngelika" — separator kept its word but lost its trailing space; safe
  // since a capital glued directly onto "and" never occurs otherwise.
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

    // Unbalanced brace: one stray `{` used to silently consume the rest of
    // the file, swallowing later entries instead of just skipping this one.
    // Resync from the next `@` that starts a line instead.
    if (depth > 0) {
      const resync = text.slice(at + 1).search(/(?:^|\n)[ \t]*@/)
      if (resync === -1) break
      // Relative to at+1, and the match may include the newline.
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
 *  *before* dropping braces — `{\"o}`/`\"{o}` need the braces still present
 *  when `unescapeLatex` runs. The `[{}]` strip after still handles plain
 *  capitalization braces like `{DNA}`. */
function cleanBibValue(raw: string): string {
  return unescapeLatex(unwrapBibValue(raw))
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Clean a BibTeX path/URL value (e.g. `file`). Not `cleanBibValue`: a
 *  Windows path like `C:\Users\name\file.pdf` would have its backslashes
 *  mangled by `unescapeLatex`'s catch-all fallback. */
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
  // First top-level comma separates the citation key from its fields.
  const parts = splitTopLevel(body, ',')
  const fieldsStr = parts.length > 1 ? body.slice(parts[0].length + 1) : ''
  const fields = parseBibFields(fieldsStr)

  const title = fields.has('title') ? cleanBibValue(fields.get('title')!) : ''
  if (!title) return null // no title, nothing worth importing

  const entry: RefEntry = { title, authors: [] }
  if (fields.has('author')) {
    // Split raw list on " and " before cleaning each name — cleaning first
    // could let a name-final control word swallow the separator's space.
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
  // journal / journaltitle (biblatex) / booktitle (chapter or conference) /
  // publisher (last resort) — first non-empty wins.
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
  /** From `N2` — kept separate from `abstractAB` so tag order can't decide
   *  which wins (see `finalizeRis`). */
  abstract?: string
  /** From `AB`, the primary abstract tag. */
  abstractAB?: string
  /** From `JF` (journal, full title), RIS's primary venue tag — kept
   *  per-tag like the abstract pair so precedence is order-independent. */
  venueJF?: string
  /** From `JO` (journal, abbreviated). */
  venueJO?: string
  /** From `T2` (secondary title — journal, or proceedings/book title). */
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
    // AB and N2 are read as alternates in the wild; prefer AB over N2 rather
    // than concatenating (risks a duplicated abstract).
    abstract: cur.abstractAB ?? cur.abstract,
    // JF (full title) > JO (abbreviation) > T2 (catch-all secondary title).
    // Priority decided here, not via an `if (!cur.x)` guard while scanning,
    // so tag order in the file can't override it.
    venue: cur.venueJF ?? cur.venueJO ?? cur.venueT2,
    pdfHint: cur.pdfHint,
  }
}

/**
 * Append a wrapped continuation line to the value it continues. Only prose
 * fields (title, abstracts) join; identifiers/paths (DO, L1, UR) and authors
 * (one per line) are excluded since a continuation there means a malformed
 * file, not a long value.
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

  // Tag whose value a continuation line belongs to (RIS wraps long values
  // onto untagged following lines).
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
      // Finalize whatever was in progress rather than overwriting `cur` and
      // losing it — files missing `ER` lines exist, and every record but the
      // last would otherwise silently vanish.
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
      // RIS can carry the same LaTeX escapes as BibTeX (e.g. round-tripped
      // via a converter), so title/author get the same unescape — but not
      // DO/L1/UR below, which are identifiers/paths, not prose.
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
  // No trailing `ER  -`: still keep the last record rather than dropping it.
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

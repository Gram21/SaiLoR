/**
 * Parse reference-manager exports (BibTeX / RIS / CSL-JSON) into a flat list of
 * entries for the project editor's "Import references…" flow. These files are
 * hand-edited far more often than any other input this app reads, so every
 * parser here is total: a malformed entry is skipped, and `parseReferences`
 * itself never throws — a bad file just yields fewer (or zero) entries.
 */

export interface RefEntry {
  title: string
  authors: string[]
  doi?: string
  year?: number
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

/** Strip one layer of `{...}`/`"..."` wrapping, then drop any braces left inside
 *  (BibTeX uses them mid-value only to protect capitalization, e.g. `{DNA}`)
 *  and unescape the handful of LaTeX sequences plain text actually uses. */
function cleanBibValue(raw: string): string {
  let v = raw.trim()
  if (v.length >= 2 && v.startsWith('{') && v.endsWith('}')) v = v.slice(1, -1)
  else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  return v
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
  const first = cleanBibValue(raw.split(';')[0] ?? '')
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
    entry.authors = cleanBibValue(fields.get('author')!)
      .split(/\s+and\s+/i)
      .map(normalizeAuthorName)
      .filter(Boolean)
  }
  if (fields.has('doi')) {
    const doi = cleanBibValue(fields.get('doi')!)
    if (doi) entry.doi = doi
  }
  if (fields.has('year')) {
    const y = cleanBibValue(fields.get('year')!).match(/\d{4}/)
    if (y) entry.year = Number(y[0])
  }
  if (fields.has('file')) {
    const hint = extractBibFileHint(fields.get('file')!)
    if (hint) entry.pdfHint = hint
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
    pdfHint: cur.pdfHint,
  }
}

function parseRis(text: string): RefEntry[] {
  const lines = text.split(/\r\n|\r|\n/)
  const records: RefEntry[] = []
  let cur: RisDraft | null = null

  for (const rawLine of lines) {
    const m = rawLine.match(/^([A-Za-z][A-Za-z0-9])\s{0,2}-\s?(.*)$/)
    if (!m) continue
    const tag = m[1].toUpperCase()
    const value = m[2].trim()

    if (tag === 'TY') {
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
      case 'TI':
      case 'T1':
        if (!cur.title && value) cur.title = value
        break
      case 'AU':
      case 'A1':
        if (value) cur.authors.push(normalizeAuthorName(value))
        break
      case 'DO':
        if (value) cur.doi = value
        break
      case 'PY':
      case 'Y1': {
        if (cur.year === undefined) {
          const y = value.match(/\d{4}/)
          if (y) cur.year = Number(y[0])
        }
        break
      }
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

  let year: number | undefined
  const issued = raw.issued
  if (isRecord(issued) && Array.isArray(issued['date-parts'])) {
    const first = issued['date-parts'][0]
    if (Array.isArray(first) && typeof first[0] === 'number') year = first[0]
  }

  return { title, authors, doi, year }
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

/**
 * Splits free text into plain-text and URL segments, so a caller can render the
 * URLs as clickable links and everything else as text — without ever building
 * HTML from the input. A schema field's `description` is exactly this kind of
 * text: hand-written by whoever authored the review, sometimes with a link to
 * a source or a guideline document in it.
 *
 * `http://`/`https://` only, matching what the feature this exists for was
 * actually asked to recognize — not a bare `www.` prefix (which reads
 * ambiguously inside ordinary prose: "see www.example.com and www2 for
 * details" is not obviously two URLs) and not a general-purpose URL library.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g

/** Punctuation a URL is unlikely to end a sentence with on purpose — stripped
 *  from the end of a match and re-emitted as trailing plain text, so "see
 *  https://example.com." keeps its period out of the link. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/

export interface LinkifySegment {
  text: string
  /** Present only on a segment that is itself a URL. */
  href?: string
}

export function linkifyText(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = []
  let cursor = 0

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index
    if (start > cursor) segments.push({ text: text.slice(cursor, start) })

    let url = match[0]
    const trailing = TRAILING_PUNCTUATION.exec(url)
    const suffix = trailing ? trailing[0] : ''
    if (suffix) url = url.slice(0, url.length - suffix.length)

    // A URL reduced to nothing but stripped punctuation (degenerate, but
    // possible against an adversarial or just malformed description) is not a
    // link — put the original text back verbatim rather than emit an empty href.
    if (url) {
      segments.push({ text: url, href: url })
      if (suffix) segments.push({ text: suffix })
    } else {
      segments.push({ text: match[0] })
    }

    cursor = start + match[0].length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}

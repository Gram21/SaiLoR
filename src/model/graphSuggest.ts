// [impl->req~ui-400~1]
import { isCypher } from './graphCypher'

export interface Suggestion {
  /** Replaces input[from, to]. */
  from: number
  to: number
  items: string[]
}

const NODE_LABELS = ['Paper', 'Author', 'Venue', 'Keyword', 'Choice', 'Answer']
const EDGE_TYPES = ['authoredBy', 'publishedIn', 'hasKeyword', 'cites', 'hasAnswer']
const CYPHER_WORDS = ['MATCH', 'WHERE', 'RETURN', 'DISTINCT', 'AS', 'LIMIT', 'AND', 'OR', 'NOT', 'CONTAINS', 'STARTS WITH', 'ENDS WITH', 'IN', 'IS NULL', 'IS NOT NULL', 'count(*)']
const TEXT_KEYS = ['type:', 'author:', 'venue:', 'keyword:', 'choice:', 'answer:', 'field:', 'depth:']

const WORD = /[\p{L}\p{N}_-]*$/u
const MAX_ITEMS = 8

const pick = (all: string[], prefix: string) => {
  const p = prefix.toLowerCase()
  return all.filter((x) => x.toLowerCase().startsWith(p) && x.toLowerCase() !== p).slice(0, MAX_ITEMS)
}

/** Completion proposals for the word before `caret`; `fields` are the schema field names, `props` the Cypher property names. */
export function suggest(input: string, caret: number, fields: string[], props: string[] = [], force = false): Suggestion | null {
  const before = input.slice(0, caret)
  const prefix = WORD.exec(before)![0]
  const from = caret - prefix.length
  const head = before.slice(0, from)
  const done = (items: string[]) => (items.length ? { from, to: caret, items } : null)

  if (isCypher(input)) {
    if (/\[[^\]]*[:|]\s*$/.test(head)) return done(pick(EDGE_TYPES, prefix))
    if (/\([^(){}]*:\s*$/.test(head)) return done(pick(NODE_LABELS, prefix))
    if (/[\p{L}\p{N}_]\.$/u.test(head) || /\{(?:[^{}]*,)?\s*$/.test(head)) return done(pick(props, prefix))
    if (/['"`]/.test(head.slice(-1))) return null
    return prefix || force ? done(pick(CYPHER_WORDS, prefix)) : null
  }

  const colon = /([^\s:="]+):$/.exec(head)
  if (colon) {
    const key = colon[1].toLowerCase()
    if (key === 'type') return done(pick(NODE_LABELS.map((l) => l.toLowerCase()), prefix))
    if (key === 'field') return done(pick(fields, prefix))
    return null
  }
  if (!prefix && !force) return null
  return done(pick([...TEXT_KEYS, ...fields.map((f) => `${f}=`), 'MATCH'], prefix.replace(/^-/, '')))
}

const BUILT_IN_PROPS = ['id', 'type', 'label', 'field', 'doi', 'year', 'abstract']

/** Cypher property names: the built-in ones, then the answer keys of the graph (in backticks if not a plain name). */
export function cypherProps(answerKeys: Iterable<string>): string[] {
  const extra = [...new Set(answerKeys)].filter((k) => !BUILT_IN_PROPS.includes(k)).sort()
  return [...BUILT_IN_PROPS, ...extra.map((k) => (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(k) ? k : `\`${k.replace(/`/g, '``')}\``))]
}

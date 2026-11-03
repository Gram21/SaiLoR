import { Fragment, createElement, useSyncExternalStore, type ReactNode } from 'react'
import en from './locales/en.json'
import de from './locales/de.json'
import it from './locales/it.json'
import { loadLanguage, saveLanguage, type Language } from './state/settings'

export type MessageKey = keyof typeof en
export type PluralKey = MessageKey extends infer K ? (K extends `${infer B}_other` ? B : never) : never
export type Params = Record<string, string | number>
export type TagRenderers = Record<string, (children: ReactNode) => ReactNode>

// [impl->req~ui-130~1]
export const MESSAGES: Record<Language, Record<MessageKey, string>> = { en, de, it }

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', de: 'Deutsch', it: 'Italiano' }

let current: Language = loadLanguage()
const listeners = new Set<() => void>()
if (typeof document !== 'undefined') document.documentElement.lang = current

export function getLanguage(): Language {
  return current
}

// [impl->req~ui-110~1]
export function setLanguage(lang: Language): void {
  saveLanguage(lang)
  if (lang === current) return
  current = lang
  if (typeof document !== 'undefined') document.documentElement.lang = lang
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// [impl->req~ui-110~1]
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage)
}

function fill(text: string, params?: Params): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

// [impl->req~ui-120~1]
export function t(key: MessageKey, params?: Params): string {
  return fill(MESSAGES[current][key] || MESSAGES.en[key] || key, params)
}

// [impl->req~ui-120~1]
export function tp(key: PluralKey, count: number, params?: Params): string {
  const exact = `${key}_${new Intl.PluralRules(current).select(count)}`
  return t((exact in MESSAGES.en ? exact : `${key}_other`) as MessageKey, { count, ...params })
}

const TAG = /<(\w+)>([\s\S]*?)<\/\1>/
const PLAIN_TAGS = new Set(['strong', 'em', 'code', 'kbd', 'b', 'i'])

function parse(text: string, params?: Params, tags?: TagRenderers): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  for (let m = TAG.exec(rest); m; m = TAG.exec(rest)) {
    const [whole, name, inner] = m
    if (m.index > 0) out.push(fill(rest.slice(0, m.index), params))
    const children = parse(inner, params, tags)
    const render = tags?.[name]
    out.push(
      render
        ? createElement(Fragment, null, render(createElement(Fragment, null, ...children)))
        : PLAIN_TAGS.has(name)
          ? createElement(name, null, ...children)
          : createElement(Fragment, null, ...children),
    )
    rest = rest.slice(m.index + whole.length)
  }
  if (rest) out.push(fill(rest, params))
  return out
}

// [impl->req~ui-120~1]
export function rich(key: MessageKey, params?: Params, tags?: TagRenderers): ReactNode {
  return createElement(Fragment, null, ...parse(t(key), params, tags))
}

// [impl->req~ui-120~1]
export function useT(): typeof t {
  useLanguage()
  return t
}

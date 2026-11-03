import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LANGUAGES } from './state/settings'
import { MESSAGES, getLanguage, rich, setLanguage, t, tp, type MessageKey } from './i18n'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const tags = (text: string) => [...text.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort()

afterEach(() => {
  setLanguage('en')
  vi.unstubAllGlobals()
})

// [utest->req~ui-130~1]
describe('language files', () => {
  const english = Object.keys(MESSAGES.en).sort()

  it.each(LANGUAGES)('%s has exactly the English keys', (lang) => {
    const keys = Object.keys(MESSAGES[lang]).sort()
    expect(english.filter((k) => !keys.includes(k)), 'missing keys').toEqual([])
    expect(keys.filter((k) => !english.includes(k)), 'extra keys').toEqual([])
  })

  it.each(LANGUAGES)('%s keeps the placeholders and tags of each English text', (lang) => {
    const differ = (Object.keys(MESSAGES.en) as MessageKey[]).filter(
      (k) =>
        placeholders(MESSAGES[lang][k]).join() !== placeholders(MESSAGES.en[k]).join() ||
        tags(MESSAGES[lang][k]).join() !== tags(MESSAGES.en[k]).join(),
    )
    expect(differ).toEqual([])
  })

  it.each(LANGUAGES)('%s has no empty text', (lang) => {
    expect(Object.entries(MESSAGES[lang]).filter(([, v]) => v.trim() === '')).toEqual([])
  })
})

// [utest->req~ui-120~1]
describe('t', () => {
  it('uses English by default in tests', () => {
    expect(getLanguage()).toBe('en')
    expect(t('settings.title')).toBe('Settings')
  })

  it('fills {name} placeholders and keeps unknown ones', () => {
    expect(t('settings.git.found', { version: '2.43' })).toBe('SaiLoR uses the git on your PATH: 2.43.')
    expect(t('settings.git.found')).toBe('SaiLoR uses the git on your PATH: {version}.')
  })

  it('follows the active language and sets the lang attribute', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
    setLanguage('de')
    expect(t('settings.title')).toBe('Einstellungen')
    expect(document.documentElement.lang).toBe('de')
    expect(localStorage.setItem).toHaveBeenCalledWith('slr.language', 'de')
  })

  // [utest->req~ui-140~1]
  it('sets the text direction of the document from the language', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
    setLanguage('fa')
    expect(document.documentElement.lang).toBe('fa')
    expect(document.documentElement.dir).toBe('rtl')
    setLanguage('en')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('falls back to English when a text is empty', () => {
    const saved = MESSAGES.de['settings.title']
    MESSAGES.de['settings.title'] = ''
    try {
      setLanguage('de')
      expect(t('settings.title')).toBe('Settings')
    } finally {
      MESSAGES.de['settings.title'] = saved
    }
  })
})

// [utest->req~ui-120~1]
describe('tp', () => {
  it('picks the plural form and fills {count}', () => {
    expect(tp('strict.picker.papers', 1)).toBe('1 paper')
    expect(tp('strict.picker.papers', 0)).toBe('0 papers')
    expect(tp('strict.picker.papers', 2)).toBe('2 papers')
  })

  it('uses the one form for a count other than 1 only when it shows the count', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
    setLanguage('fr')
    expect(tp('strict.picker.papers', 0)).toBe('0 article')
    expect(tp('toolbar.corrupt.title', 0)).toBe(
      '0 fichiers d’annotation n’ont pas pu être lus — cliquez pour voir la liste',
    )
    expect(tp('toolbar.corrupt.title', 1)).toBe(t('toolbar.corrupt.title_one'))
  })
})

// [utest->req~ui-120~1]
describe('rich', () => {
  const html = (key: MessageKey, ...rest: Parameters<typeof rich> extends [unknown, ...infer R] ? R : never) => {
    const node = rich(key, ...rest)
    expect(isValidElement(node)).toBe(true)
    return renderToStaticMarkup(node as ReactElement)
  }

  it('renders plain text and fills placeholders', () => {
    expect(html('settings.git.found', { version: '<b>2</b>' })).toBe('SaiLoR uses the git on your PATH: &lt;b&gt;2&lt;/b&gt;.')
  })

  it('turns markup tags into elements and uses custom renderers', () => {
    const saved = MESSAGES.en['settings.title']
    MESSAGES.en['settings.title'] = 'Press <kbd>Ctrl</kbd> and <strong>read <em>{what}</em></strong>, <link>here</link>, <x>plain</x>'
    try {
      expect(html('settings.title', { what: 'this' }, { link: (c) => createElement('a', { href: '#h' }, c) })).toBe(
        'Press <kbd>Ctrl</kbd> and <strong>read <em>this</em></strong>, <a href="#h">here</a>, plain',
      )
    } finally {
      MESSAGES.en['settings.title'] = saved
    }
  })
})

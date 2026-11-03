import type { SaveHandle } from '../platform/adapter'

if (typeof globalThis.localStorage?.clear !== 'function') {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
    configurable: true,
  })
}

export const written: string[] = []

export const mockPlatform = {
  kind: 'electron' as const,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  getOsInfo: () => null,
  saveProject: async (text: string, handle: SaveHandle) => {
    written.push(text)
    return handle
  },
  rebasePdfPaths: async (pdfPaths: string[]) => pdfPaths,
}

export const HANDLE = { kind: 'electron' as const, path: '/reviews/strict.json' }

export const paper = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  authors: [],
  pdf: `${id}.pdf`,
  ...extra,
})

/** Ann works on a (seat 1) and c (seat 2); Bob works on a (seat 2) and b (seat 1). */
export function projectText(papers = [paper('a'), paper('b'), paper('c')]) {
  return JSON.stringify({
    version: 1,
    config: {
      schema: [{ name: 'Relevant', type: 'boolean' }],
      reviewers: 2,
      strict: true,
      persons: [
        { id: 'ann', name: 'Ann' },
        { id: 'bob', name: 'Bob' },
      ],
      assignments: {
        a: [
          { person: 'ann', seat: 1 },
          { person: 'bob', seat: 2 },
        ],
        b: [{ person: 'bob', seat: 1 }],
        c: [{ person: 'ann', seat: 2 }],
      },
    },
    papers,
  })
}

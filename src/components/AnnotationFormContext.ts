import { createContext } from 'react'
import type { PathSeg } from '../state/store'
import type { ResolvedDef } from '../model/schema'
import type { FieldValue } from '../model/annotations'

/** The three writes the annotation form makes. Provided only by the project
 *  editor's preview, which keeps the answers in local state; `null` (the
 *  default) means the form writes to the project store as usual and offers
 *  the PDF, AI and consolidation tools. */
export interface AnnotationFormWrites {
  setFieldValue: (path: PathSeg[], name: string, index: number, value: FieldValue) => string | null
  addInstance: (path: PathSeg[], def: ResolvedDef) => void
  removeInstance: (path: PathSeg[], name: string, index: number) => void
}

export const AnnotationFormContext = createContext<AnnotationFormWrites | null>(null)

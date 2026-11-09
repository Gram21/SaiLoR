import { CHART_TYPES, DEFAULT_CONFIG, PALETTES, type DiagramConfig } from '../model/diagram'
import { NODE_TYPES, type GraphNodeType } from '../model/graph'
import { safeGet, safeSet } from './settings'

// [impl->req~ui-380~1]
const DIAGRAM_KEY = 'slr.result.diagram'
const GRAPH_KEY = 'slr.result.graph'

const clamp = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback)

function read(key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(safeGet(key) ?? 'null')
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The stored diagram settings, each value checked; anything missing or wrong falls back to the default. */
export function loadDiagramConfig(): DiagramConfig {
  const stored = read(DIAGRAM_KEY)
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG }
  for (const [key, dflt] of Object.entries(DEFAULT_CONFIG)) {
    if (typeof stored[key] === typeof dflt && key !== 'colors') config[key] = stored[key]
  }
  const colors = stored.colors
  config.colors = colors && typeof colors === 'object' ? Object.fromEntries(Object.entries(colors).filter(([, v]) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v))) : {}
  const c = config as unknown as DiagramConfig
  if (!CHART_TYPES.includes(c.type)) c.type = DEFAULT_CONFIG.type
  if (!(c.palette in PALETTES)) c.palette = DEFAULT_CONFIG.palette
  if (c.sort !== 'label' && c.sort !== 'count') c.sort = DEFAULT_CONFIG.sort
  c.limit = clamp(c.limit, 2, 50, DEFAULT_CONFIG.limit)
  c.width = clamp(c.width, 300, 3000, DEFAULT_CONFIG.width)
  c.height = clamp(c.height, 200, 2000, DEFAULT_CONFIG.height)
  return c
}

export function saveDiagramConfig(config: DiagramConfig): void {
  safeSet(DIAGRAM_KEY, JSON.stringify(config))
}

export interface GraphFilters {
  /** Bit t hides edge type t of the graph legend. */
  edges: number
  nodeTypes: GraphNodeType[]
}

/** The stored graph filters: hidden relations and hidden node types. */
export function loadGraphFilters(): GraphFilters {
  const stored = read(GRAPH_KEY)
  return {
    edges: clamp(stored.edges, 0, 0xffff, 0),
    nodeTypes: Array.isArray(stored.nodeTypes) ? NODE_TYPES.filter((t) => (stored.nodeTypes as unknown[]).includes(t)) : [],
  }
}

export function saveGraphFilters(filters: GraphFilters): void {
  safeSet(GRAPH_KEY, JSON.stringify(filters))
}

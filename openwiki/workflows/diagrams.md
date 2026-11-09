---
type: workflow
title: Result view diagrams
description: How the Diagrams tab of the Result view turns annotation answers into bar, stacked, line, pie and heat-map charts in a worker, and exports them as SVG, PNG, vector PDF or CSV.
tags: [diagrams, result-view, worker, svg, export]
sources:
  - id: openwiki-source-2318a70b0acbedbe7b0e8fcd
    resource: repo://src/components/diagramExport.ts
  - id: openwiki-source-be8efa980f6f803187e3515a
    resource: repo://src/components/DiagramView.tsx
  - id: openwiki-source-1698283099d4f16a397fb9ec
    resource: repo://src/components/ResultView.tsx
  - id: openwiki-source-5824e047f87584585b2d048a
    resource: repo://src/model/diagram.test.ts
  - id: openwiki-source-bc7177f8742e2d57b99bec61
    resource: repo://src/model/diagram.ts
  - id: openwiki-source-025ae158044569f9d8cf5de6
    resource: repo://src/model/diagram.worker.ts
  - id: openwiki-source-0e19ae92fbed2d58eead62fc
    resource: repo://src/model/diagramSvg.ts
  - id: openwiki-source-5625f4d1b05fe4b38ce8c3e4
    resource: repo://src/model/imagePdf.ts
  - id: openwiki-source-05ae7938a23aa4d94a38b387
    resource: repo://src/model/vectorPdf.ts
  - id: openwiki-source-e29db6bd8a5de35acbd207c6
    resource: repo://src/state/resultSettings.ts
generated: { by: "claude-code", at: "2026-11-09T08:29:20.744Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-09T08:29:20.744Z
---

# Result view diagrams

The toolbar's **Result view** menu (renamed from "Graph") opens one modal, `ResultView`, with two tabs: the
[knowledge graph](knowledge-graph.md) and **Diagrams** (`src/components/ResultView.tsx`). The Diagrams tab is
`DiagramView`: settings in a side panel, a live preview beside it, and export buttons for SVG, PNG, PDF and CSV. The settings are kept in `localStorage` (see below).

## Data flow

1. `DiagramView` starts a module Worker (`src/model/diagram.worker.ts`). jsdom has no `Worker`, so tests and
   other worker-less hosts run the same `diagramHost` inline.
2. When the project or the graph seat changes, the view posts a `data` message. It carries `slimProject(project)`
   (schema plus papers without abstracts, annotations and reviews) and the annotation trees from `graphTrees`.
   The host builds the knowledge graph once with `buildGraph` and keeps it.
3. When any setting changes, the view posts a `render` message after a 120 ms debounce. Each message has an
   increasing id, and the view ignores replies that are not the latest id.
4. For a `render` message the host runs `aggregate` (counts per category and series), then `renderDiagram`, and
   replies with the SVG string, the series keys, the category count, the paper count and the counted data (for the data table and CSV) — or an `error`.
5. The view shows the SVG as `<img src="data:image/svg+xml,...">` sized to the configured width and height.

The diagram data comes from the graph, not from raw annotations. `paperValues` reads a dimension per paper:
`@year`, or `@venue`, `@author`, `@keyword` through their graph edges, or any schema field (`f:<id>`) by walking
`hasAnswer` edges down to Choice nodes and field values. So every chart sees the same data as the graph view.

## Aggregation rules

- An optional filter (`filterDim` plus `filterText`) keeps only papers where one value of that dimension contains the text, ignoring case.
- Papers without a value are skipped, unless "count papers without a value" adds a `(none)` category.
- A paper with several values counts once in each category.
- `limit` keeps the biggest categories and series; the rest merge into `Other`.
- Stacked bars can show shares of 100 %, and bar charts can be horizontal. `diagramCsv` writes the counts and neutralises formulas.
- Sorting is by label (natural, numeric-aware) or by count; line charts always keep label order.

## Rendering and the well-formed SVG invariant

`renderDiagram` (`src/model/diagramSvg.ts`) is pure string building, so it runs in the worker. It has no font
metrics, so label widths are estimated. Colours come from three colour-blind-safe palettes (Okabe-Ito first); the
user can override single series colours.

The SVG must be well-formed XML: an `<img>` with invalid SVG shows only a broken-image mark. The earlier
"?" bug came from a `<text>` element with two `fill` attributes. The `text()` helper now adds its default `fill`
only when the caller passes none, and `diagram.test.ts` parses every chart type with `DOMParser` to guard this.

## Export

`diagramExport.ts` writes the SVG string as is. PNG and PDF need the main thread:

| Format | How |
|--------|-----|
| SVG | the string, written with `writeTextFile` |
| PNG | canvas at 2x scale, `toBlob` |
| PDF | `svgToVectorPdf` (`src/model/vectorPdf.ts`) parses the SVG with `DOMParser` and writes vector operators with Helvetica text; if a character is outside WinAnsi it returns null and the old raster path runs |
| CSV | `diagramCsv` of the counted data |

The vector PDF draws rect, line, polyline, circle, path (arcs flattened) and text, measuring text with a canvas.
The raster fallback draws the SVG at 3x on a canvas, deflates the RGB bytes and wraps them with `imagePdf`.
Both PDF writers share `pdfDocument` in `src/model/imagePdf.ts` for the header, objects, xref and trailer.
The view asks the platform for a path with `pickTextExportPath`, then
writes with `writeTextFile` or `writeBinaryFile`. In the desktop shell the path must come from an export dialog,
and the dialog accepts `svg`, `png`, `pdf` and `csv` ([Tauri shell](../operations/tauri-shell.md)). The online demo
adapter does not save.

## Saved settings

`ResultView` starts the diagram config from `loadDiagramConfig` and saves it on every change
(`src/state/resultSettings.ts`, key `slr.result.diagram`). The loader checks each value against the defaults,
validates colours and clamps sizes, and tolerates broken JSON. If the saved config names a dimension that the
open project's schema lacks, `DiagramView` resets that field.

## Tests

`src/model/diagram.test.ts` covers aggregation, each chart type, XML validity, escaping, tick steps, the inline
host and the raster PDF cross-reference table. `vectorPdf.test.ts` checks the vector PDF and `resultSettings.test.ts` the saved settings. `src/components/DiagramView.test.tsx` covers the tabs, the live title,
saving an SVG and closing with Escape ([testing](../testing.md)).

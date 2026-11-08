---
type: workflow
title: Result view diagrams
description: How the Diagrams tab of the Result view turns annotation answers into bar, stacked, line, pie and heat-map charts in a worker, and exports them as SVG, PNG or PDF.
tags: [diagrams, result-view, worker, svg, export]
verified:
  - by: openwiki/0.7.3
    at: 2026-11-08T19:43:29.846Z
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
generated: { by: "claude-code", at: "2026-11-08T19:43:29.846Z" }
---

# Result view diagrams

The toolbar's **Result view** menu (renamed from "Graph") opens one modal, `ResultView`, with two tabs: the
[knowledge graph](knowledge-graph.md) and **Diagrams** (`src/components/ResultView.tsx`). The Diagrams tab is
`DiagramView`: settings in a side panel, a live preview beside it, and export buttons for SVG, PNG and PDF.

## Data flow

1. `DiagramView` starts a module Worker (`src/model/diagram.worker.ts`). jsdom has no `Worker`, so tests and
   other worker-less hosts run the same `diagramHost` inline.
2. When the project or the graph seat changes, the view posts a `data` message. It carries `slimProject(project)`
   (schema plus papers without abstracts, annotations and reviews) and the annotation trees from `graphTrees`.
   The host builds the knowledge graph once with `buildGraph` and keeps it.
3. When any setting changes, the view posts a `render` message after a 120 ms debounce. Each message has an
   increasing id, and the view ignores replies that are not the latest id.
4. For a `render` message the host runs `aggregate` (counts per category and series), then `renderDiagram`, and
   replies with the SVG string, the series keys, the category count and the paper count — or an `error`.
5. The view shows the SVG as `<img src="data:image/svg+xml,...">` sized to the configured width and height.

The diagram data comes from the graph, not from raw annotations. `paperValues` reads a dimension per paper:
`@year`, or `@venue`, `@author`, `@keyword` through their graph edges, or any schema field (`f:<id>`) by walking
`hasAnswer` edges down to Choice nodes and field values. So every chart sees the same data as the graph view.

## Aggregation rules

- Papers without a value are skipped, unless "count papers without a value" adds a `(none)` category.
- A paper with several values counts once in each category.
- `limit` keeps the biggest categories and series; the rest merge into `Other`.
- Sorting is by label (natural, numeric-aware) or by count; line charts always keep label order.

## Rendering and the well-formed SVG invariant

`renderDiagram` (`src/model/diagramSvg.ts`) is pure string building, so it runs in the worker. It has no font
metrics, so label widths are estimated. Colours come from three colour-blind-safe palettes (Okabe-Ito first); the
user can override single series colours.

The SVG must be well-formed XML: an `<img>` with invalid SVG shows only a broken-image mark. The earlier
"?" bug came from a `<text>` element with two `fill` attributes. The `text()` helper now adds its default `fill`
only when the caller passes none, and `diagram.test.ts` parses every chart type with `DOMParser` to guard this.

## Export

`diagramExport.ts` rasterises the SVG on the main thread through an `Image` and a canvas:

| Format | How |
|--------|-----|
| SVG | the string, written with `writeTextFile` |
| PNG | canvas at 2x scale, `toBlob` |
| PDF | canvas at 3x scale, RGB bytes compressed with `CompressionStream('deflate')`, wrapped by `imagePdf` into a one-page PDF |

The PDF is a raster image, not vector. The view asks the platform for a path with `pickTextExportPath`, then
writes with `writeTextFile` or `writeBinaryFile`. In the desktop shell the path must come from an export dialog,
and the dialog accepts `svg`, `png` and `pdf` ([Tauri shell](../operations/tauri-shell.md)). The online demo
adapter does not save.

## Tests

`src/model/diagram.test.ts` covers aggregation, each chart type, XML validity, escaping, tick steps, the inline
host and the PDF cross-reference table. `src/components/DiagramView.test.tsx` covers the tabs, the live title,
saving an SVG and closing with Escape ([testing](../testing.md)).

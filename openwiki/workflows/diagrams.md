---
type: workflow
title: Result view diagrams
description: How the Diagrams tab of the Result view turns annotation answers into bar, stacked, line, pie and heat-map charts in a worker, and exports them as SVG, PNG, vector PDF (with an optional embedded system font) or CSV.
tags: [diagrams, result-view, worker, svg, export]
sources:
  - id: openwiki-source-2318a70b0acbedbe7b0e8fcd
    resource: repo://src/components/diagramExport.ts
  - id: openwiki-source-be8efa980f6f803187e3515a
    resource: repo://src/components/DiagramView.tsx
  - id: openwiki-source-bd9dfa3b4df9d6c1703d0bbc
    resource: repo://src/components/PdfFontDialog.tsx
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
  - id: openwiki-source-e650640bfefdd85cc0f29976
    resource: repo://src/model/ttf.ts
  - id: openwiki-source-05ae7938a23aa4d94a38b387
    resource: repo://src/model/vectorPdf.ts
  - id: openwiki-source-e29db6bd8a5de35acbd207c6
    resource: repo://src/state/resultSettings.ts
generated: { by: "claude-code", at: "2026-11-09T14:02:19.724Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-09T14:02:19.724Z
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
| PDF | `svgToPdf` (`diagramExport.ts`) calls `svgToVectorPdf` (`src/model/vectorPdf.ts`), which parses the SVG with `DOMParser` and writes vector operators with the built-in Helvetica faces |
| CSV | `diagramCsv` of the counted data |

The vector PDF draws rect, line, polyline, circle, path (arcs flattened) and text, measuring text with a canvas.
`imagePdf.ts` now holds only the shared `pdfDocument` writer (header, objects, xref and trailer). There is no raster PDF path.

### Characters outside WinAnsi

The built-in Helvetica and Helvetica-Bold faces cover the Windows-1252 set (Latin letters plus characters such as
€, ™, “ ”, – and —). The other standard Latin fonts, Times and Courier, cover the same set, so a different
standard font would not widen it. A text with any other character needs an embedded font. The flow in `DiagramView`:

1. `nonWinAnsiChars(svg)` lists those characters. If the list is empty, the PDF is written at once.
2. `findPdfFont` reads installed fonts through `platform.readSystemFont(index)` and returns the first TrueType
   font that has every character. It returns no font, with a reason, in three cases: the characters need text
   shaping (Hebrew, Arabic, Indic and similar scripts, which a PDF cannot set one glyph per character), no readable
   font exists, or no font covers all characters. `parseTrueType` also refuses fonts with `fsType` bits that forbid
   embedding, CFF fonts and TTC collections.
3. `PdfFontDialog` always asks. If a font was found, it offers to embed it or to save SVG instead. If not, it
   states the reason and offers only SVG (or cancel).
4. On "embed", `svgToPdf` runs a probe pass to learn which glyph ids the diagram uses, cuts the font with
   `subsetTrueType` (`src/model/ttf.ts`), deflates the result and runs the final pass. A diagram PDF then carries
   kilobytes of font, not the whole file. If the font is damaged, the whole font is embedded.

The embedded font is a Type0 font (Identity-H) over a CIDFontType2 with the subset as `FontFile2`. A `ToUnicode`
CMap maps each glyph id back to its character, so the text can be copied and searched.

On desktop, `readSystemFont` calls the Rust command `pdf_system_font`, which reads from a fixed per-OS font list
([Tauri shell](../operations/tauri-shell.md)). The online demo returns no font, so the dialog offers only SVG there.

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

`src/model/diagram.test.ts` covers aggregation, each chart type, XML validity, escaping, tick steps and the inline
host. `vectorPdf.test.ts` checks the vector PDF (xref offsets, the WinAnsi set of both faces, the embedded font and its ToUnicode map), `ttf.test.ts` the TrueType parser and subsetter, and `resultSettings.test.ts` the saved settings. `src/components/DiagramView.test.tsx` covers the tabs, the live title,
saving an SVG and closing with Escape ([testing](../testing.md)).

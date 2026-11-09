---
type: workflow
title: Knowledge Graph View
description: How SaiLoR builds a graph from papers, authors, venues, keywords and answers, lays it out in a worker, filters it with depth queries or a Cypher subset with hard limits, folds the node list into a side drawer, and exports it as JSON-LD, Turtle, GraphML or CSV.
tags: [graph, knowledge-graph, cypher, force-layout, canvas, export, web-worker]
sources:
  - id: openwiki-source-11aec2ccfdae4fb5b6de97b7
    resource: repo://src/components/ExportGraphDialog.tsx
  - id: openwiki-source-c962bf9f3bb0b8a8f0500c3e
    resource: repo://src/components/graphCanvas.ts
  - id: openwiki-source-8aa7502a33c2a1bd25289806
    resource: repo://src/components/GraphView.tsx
  - id: openwiki-source-9690f05ae6bd7e4ffa4bbeb8
    resource: repo://src/components/Toolbar.tsx
  - id: openwiki-source-fe3d3b035ab01f9208923099
    resource: repo://src/model/graph.ts
  - id: openwiki-source-6e5d76ccd1a06eee34f0fcd1
    resource: repo://src/model/graphCypher.ts
  - id: openwiki-source-8bbd030e653faff5acfb3670
    resource: repo://src/model/graphCypher.worker.ts
  - id: openwiki-source-b5b58952e3738d229d72707e
    resource: repo://src/model/graphLayout.ts
  - id: openwiki-source-0cd6363bcc5b6192ad82d9e5
    resource: repo://src/model/graphQuery.ts
  - id: openwiki-source-936c4881244ab6ad1599744e
    resource: repo://src/model/graphStats.ts
  - id: openwiki-source-e29db6bd8a5de35acbd207c6
    resource: repo://src/state/resultSettings.ts
generated: { by: "claude-code", at: "2026-11-09T08:29:20.744Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-09T08:29:20.744Z
---

# Knowledge Graph View

The graph view shows a project as a network. It is read-only: nothing in it changes the project.
All graph logic is pure TypeScript under `src/model/`; the components in `src/components/` only draw it.

## Build the graph

`buildGraph(project, trees)` in `src/model/graph.ts` returns `{ nodes, edges }`.

| Node type | Source |
|---|---|
| `Paper` | One per paper; carries DOI, year and abstract |
| `Author`, `Venue`, `Keyword` | Paper metadata, shared between papers |
| `Choice`, `Answer` | Schema fields with a fixed option list (or boolean), and the values reviewers chose |

Edge types are `authoredBy`, `publishedIn`, `hasKeyword`, `cites` and `hasAnswer`.
Authors, venues and keywords are merged by normalised text, and DOIs are normalised so that `doi:` and URL forms match.

`graphSeats`, `defaultGraphSeat` and `graphTrees` pick which answers feed the graph:
- A project with one reviewer always uses its consolidated tree.
- A multi-reviewer project lets the user pick a source: each reviewer seat, and the **consolidation seat**
  (`CONSOLIDATION`) once a consolidation was saved (`hasConsolidation`). The consolidation is the default
  source when it exists, otherwise seat 1.

## Layout and drawing

- `GraphView.tsx` starts `graphLayout.worker.ts`. The worker runs `layoutHost`, a d3-force simulation that ticks within a 12 ms budget per slice and posts `Float32Array` frames back. The UI stays responsive while the layout settles.
- `layoutSettings(n)` lowers the tick count and raises the Barnes-Hut `theta` for big graphs, so a 50 000 node graph settles in seconds.
- Dragging a node sends `drag` and `release` messages to the worker. A generation number drops stale frames.
- `graphCanvas.ts` draws on a 2D canvas. `cull` skips off-screen items, labels show only above `LABEL_ZOOM` and below `LABEL_MAX` nodes, and edge types use different dash patterns.
- `jsdom` has no `Worker`, so tests run the same host code inline.

## Result view menu and image download

The toolbar has a **Result view** menu (`Toolbar.tsx`). It holds **Explore knowledge graph**, which opens
`ResultView` on the graph tab, and **Create diagrams** ([diagrams](diagrams.md)). The menu has no export item.
The graph view has its own **Export…** button that opens `ExportGraphDialog`, and the **Save** menu keeps the
graph export item too.
`GraphDownload.tsx` adds a download panel to the graph view: the user picks SVG or PNG, and the visible
area or the whole graph. `imageFrame` in `graphImage.ts` fits every placed node into an image of at most
`MAX_SIDE` (8192) pixels. `sceneToSvg` draws the shown edge types, nodes, query marks and, when zoomed in
enough, labels, without hover or selection highlight. `sceneToPng` draws the same scene on a canvas.
`GraphView` writes SVG through `platform.writeTextFile` and PNG through `platform.writeBinaryFile`, after
`pickTextExportPath`. REQ-UI-260.

## Nodes drawer

The node list is a **side drawer**, folded by default. A toggle button with the node count opens it (`aria-controls="graph-nodes-drawer"`). The canvas keeps the full width while the drawer is closed. This is requirement REQ-UI-190.

## Filter with depth queries

`parseQuery` in `src/model/graphQuery.ts` reads a simple term language:

- Free text matches node labels.
- `type:Author`, or a type name as a key, restricts the node type.
- `field:value` matches an answer on a schema field.
- A leading `-` negates a term.
- `depth:N` expands the match by N hops, with `MAX_DEPTH = 3`.

`indexGraph` builds adjacency once, and `selectSubgraph` returns the matching nodes plus their neighbours up to the depth.

## Cypher subset

A query that starts with `match` goes to a small Cypher engine in `src/model/graphCypher.ts`. It is a parser plus interpreter, not a database.

- Supported: `MATCH` patterns with node labels, edge types, `*` hop ranges, `WHERE` comparisons, `RETURN`, `DISTINCT`, `count(*)` and `LIMIT`.
- Refused with a clear error: `CREATE`, `MERGE`, `DELETE`, `SET`, `REMOVE`, `OPTIONAL`, `WITH`, `UNWIND`, `CALL`, `ORDER`, `SKIP`, `UNION`, `LOAD`, `FOREACH`.
- Hard limits: input length `MAX_INPUT` (4 000), nesting `MAX_NESTING` (32), path hops `MAX_HOPS` (3), result rows `MAX_ROWS` (10 000), and `MAX_WORK` (2 000 000) steps of matching work.
- `GraphView` runs the query in `graphCypher.worker.ts`. If the worker does not answer within `CYPHER_TIMEOUT_MS` (20 s), the view terminates the worker and shows a timeout error. The next query starts a fresh worker.
- `cypherSubgraph` turns the result rows back into a subgraph so the canvas can draw it.

Error messages are i18n keys under `graphView.cypher.*`.

## Node-type filter, statistics and saved filters

The side panel has a **Node types** list with one check box per type present in the graph (`NODE_TYPES` in
`src/model/graph.ts`). `GraphView` drops nodes of hidden types and their edges from the shown subgraph.
The **Statistics** section runs `graphStats` (`src/model/graphStats.ts`) on that subgraph only when it is open.
It uses union-find for components and returns node and edge counts, average degree, the largest component and
the five highest-degree nodes; a click on a hub focuses that node. A selected paper has **Open paper**, and a
Cypher table has **Save table as CSV**.
The edge-type bitmask and the hidden node types are loaded from and saved to `localStorage` by
`src/state/resultSettings.ts` (key `slr.result.graph`).

## Export

`ExportGraphDialog` offers four formats, all built by pure functions in `src/model/graph.ts`:

| Format | Function |
|---|---|
| JSON-LD | `toJsonLd` |
| Turtle | `toTurtle` |
| GraphML | `toGraphMl` |
| CSV (two files: nodes and edges) | `toCsvNodes`, `toCsvEdges` |

Escaping functions (`turtleString`, `xmlText`, `csvCell`) keep reviewer-written text from breaking the output format. `csvCell` also neutralises formula-leading cells.

## Tests and requirements

The behaviour is traced to `REQ-DAT-480` to `REQ-DAT-520` and `REQ-UI-190` to `REQ-UI-250` in `docs/requirements/`.
Focused tests: `graph.test.ts`, `graphQuery.test.ts`, `graphCypher.test.ts`, `graphLayout.test.ts` under `src/model/`, and `GraphView.test.tsx`.

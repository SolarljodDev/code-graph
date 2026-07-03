# code-graph

Parses a C codebase directly with [tree-sitter](https://tree-sitter.github.io/tree-sitter/) and generates a **static HTML site of Mermaid diagrams** — open `index.html` in any browser, nothing to install, works offline (the renderer is bundled into the output).

The diagrams follow the classic **data-flow diagram** idea (functions + data stores as two node kinds), which is what makes interrupt-driven embedded code readable: an ISR node alone says nothing, but "ISR *writes* `adc_buf`, *sets* `data_ready`; main loop *reads* both" shows the actual architecture.

## What it extracts

- **Functions** — including interrupt handlers (`*_IRQHandler` / `*_Handler`, highlighted red) and `main` (green).
- **Global variables** — file-scope definitions, with `static` / `volatile` flags (volatile = ISR↔main communication channels, highlighted).
- **Read / write edges** — for every function, which globals it reads, writes, or both (assignments, `++`/`--`, compound assignments, address-of; array writes attributed to the array, `*ptr = x` counts as a read of the pointer).
- **Call edges** — resolved across all scanned files; calls into libraries/macros shown as dashed external nodes. Functions passed as values (callbacks) count as call edges too.
- **Descriptions from comments** — a comment directly adjacent to a declaration (same-line trailing comment, or comment lines immediately above with no blank line) becomes the description of that function/variable: shown inside function nodes, in hover tooltips and in the index tables. Section banners (`// ==== ... ====`) are recognized and never attached to the declaration below them.

## Viewer features

- **ELK layout** (Eclipse Layout Kernel, layered/Sugiyama with orthogonal edge routing) instead of mermaid's default dagre — fewer crossings, no long diagonal edges. Bundled offline as `mermaid-elk.min.js` (built once with esbuild, cached in `dist/`).
- **Hover highlighting** — hovering a node fades everything except the node, every edge from/to it and its direct neighbors; hovering an edge highlights the edge and both endpoints.
- **Cursor tooltip** — kind, signature/type, file, description, writers/readers list (from `graph-data.js`).
- **Self-describing nodes** — every node carries a small dim kind tag on the left (`func` / `ISR` / `main` / `var` / `volatile` / `ext` / `file`), so no external color legend is needed.

## Output structure

```
outDir/
  index.html          overview diagram + include graph + tables (files / functions / globals)
  files/<file>.html   one diagram per file: its functions & globals, plus dashed "ghost"
                      nodes for everything one step outside the file (clickable)
  functions/<fn>.html one diagram per function: callers, callees, globals touched
  mermaid-elk.min.js  bundled renderer: mermaid + ELK layout (offline)
  app.js              viewer runtime: rendering, hover highlighting, tooltips
  graph-data.js       node metadata for tooltips
```

Edge semantics: `func → var` = write, `var → func` = read, `↔` = read+write, dotted = call. Every node is clickable and navigates to its page. If the whole program is too big for one readable diagram (>130 nodes), the overview collapses to a file-level graph with aggregated edge counts.

## Usage

```
npm install
node index.mjs <outDir> <sourceRoot1> [<sourceRoot2> ...]
```

Or, from any directory, using the bundled wrapper:

```
"<path-to-this-repo>\graph.cmd" <outDir> <sourceRoot1> [<sourceRoot2> ...]
```

### Drop-in launcher (no local clone needed)

Copy just `codegraph.ps1` (and `codegraph.cmd`, for double-click convenience) into the root of any C project and run it:

```
.\codegraph.cmd
```

On first run it clones this repo into `%LOCALAPPDATA%\code-graph`, runs `npm install` there once, then auto-detects every `inc`/`src` pair under the folder you dropped it in and generates `.\graph-html\` next to itself. Later runs just `git pull` the cached copy and re-generate. Requires Git and Node.js (searched in common install locations even if not on PATH).

Options:
```
.\codegraph.ps1 -OutDir .\my-graph
.\codegraph.ps1 -Roots .\device,.\user
```

## Setup on a new machine

`tree-sitter` and `tree-sitter-c` ship prebuilt native binaries (via `node-gyp-build`/`prebuildify`, N-API based) for win32-x64, linux-x64, darwin-x64/arm64. On a matching platform, `npm install` just downloads the prebuilt binary — no compiler toolchain needed. Only Node.js itself is required.

## Known fix baked in

`node-tree-sitter` 0.21.x throws `Invalid argument` when parsing a single string buffer of 32768+ UTF-16 code units. This script reads files through a chunked callback (16 KB chunks) instead of passing the whole file as one string, which avoids the bug — relevant for large generated headers (e.g. CMSIS device headers).

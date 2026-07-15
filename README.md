# code-graph

Parses a C codebase directly with [tree-sitter](https://tree-sitter.github.io/tree-sitter/) and generates a **static HTML site of graphviz diagrams** — open `index.html` in any browser, nothing to install, works offline (every diagram is a plain SVG, already laid out at generation time).

The diagrams follow the classic **data-flow diagram** idea (functions + data stores as two node kinds), which is what makes interrupt-driven embedded code readable: an ISR node alone says nothing, but "ISR *writes* `adc_buf`, *sets* `data_ready`; main loop *reads* both" shows the actual architecture.

## What it extracts

- **Functions** — including interrupt handlers (`*_IRQHandler` / `*_Handler`, highlighted red) and `main` (green).
- **Global variables** — file-scope definitions, with `static` / `volatile` flags (volatile = ISR↔main communication channels, highlighted).
- **Read / write edges** — for every function, which globals it reads, writes, or both (assignments, `++`/`--`, compound assignments, address-of; array writes attributed to the array, `*ptr = x` counts as a read of the pointer).
- **Call edges** — resolved across all scanned files; calls into libraries/macros shown as dashed external nodes. Functions passed as values (callbacks) count as call edges too.
- **Peripherals** (level 0 only) — register blocks reached via `X->field` that never resolve to a real variable (the CMSIS/HAL convention of a vendor-header macro like `#define DMA1_Channel2 ((DMA_Channel_TypeDef*)...)`) are recognized as hardware instances rather than dropped. Combined with `NVIC_EnableIRQ(X_IRQn)` calls and an IRQ-handler-name match (`DMA1_Channel2_IRQHandler` ↔ `DMA1_Channel2`, including shared vectors like `TIM1_UP_TIM10_IRQHandler`), this surfaces which code arms an interrupt line and which peripheral's hardware event actually fires which handler — the mechanism behind ping-pong/handoff patterns between ISRs, without hard-coding any particular idiom.
- **Descriptions from comments** — a comment directly adjacent to a declaration (same-line trailing comment, or comment lines immediately above with no blank line) becomes the description of that function/variable: shown inside function nodes, in hover tooltips and in the index tables. Section banners (`// ==== ... ====`) are recognized and never attached to the declaration below them.

## Viewer features

- **Graphviz layout**, computed once at generation time via `@hpcc-js/wasm-graphviz` (no native binary needed, no browser-side layout step). Every diagram ships with all three of `dot` (layered, best for the DAG-shaped ones: include graph, per-function callers/callees, control-flow), `neato` and `fdp` (force-directed, no rank concept — the right fit for hub-heavy graphs like level 0 and the file/overview diagrams, where a strict ranked layout would cram unrelated nodes into one column) pre-rendered; a per-diagram toolbar next to its maximize button switches between them instantly, since it's just swapping which pre-built SVG is shown.
- **Mouse pan & zoom** — the wheel zooms the diagram at the cursor (the page scrolls only when the cursor is outside a diagram); pressing and dragging the left button on empty background pans. The `+`/`−` buttons zoom around the viewport center.
- **Click to pin, double-click to navigate** — hovering a node or edge highlights its connections as before; a single click pins that highlight so moving the mouse to inspect other parts of a busy diagram doesn't lose it, until you click empty background (or the same element again) to release it. Double-click a node to navigate to its page — the click that starts a drag is swallowed so panning never mis-fires a pin/unpin.
- **Breadcrumb trail** — the top of every page shows the drill-down path (file → function → function it calls → …), stored per-tab. Landing on a page already in the trail (via a breadcrumb link or the browser Back button) truncates back to it instead of growing forever.
- **Variable importance tiers** — on the overview diagrams, globals used by many functions (and across files) render bigger and brighter; single-user globals render small and dim, whether or not they're volatile (a volatile flag touched by only one function is still visually minor, just tinted red instead of yellow so it's still recognizable as an ISR channel). The globals table is sorted by usage, with a user count column.
- **Cursor tooltip** — kind, signature/type, file, description, writers/readers list (from `graph-data.js`). Always tracks the live hover, independently of a pinned connection highlight, so it never freezes on screen after a click — it just follows whatever's currently under the cursor and disappears when nothing is.
- **Self-describing nodes** — every node carries a small dim kind tag on the left (`func` / `ISR` / `main` / `var` / `volatile` / `ext` / `file` / `периферия`), so no external color legend is needed. Peripheral nodes render as hexagons to read as hardware rather than data.
- **Variables toggle** — diagrams that mix functions/peripherals with globals (level 0, overview, per-file) carry a "переменные" checkbox next to the engine switcher to hide every variable/data-channel node and its edges, leaving just the function/peripheral structure.

## Output structure

```
outDir/
  index.html          overview diagram + include graph + tables (files / functions / globals)
  files/<file>.html   one diagram per file: its functions & globals, plus dashed "ghost"
                      nodes for everything one step outside the file (clickable)
  functions/<fn>.html one diagram per function: control flow (CFG), callers, callees, globals touched
  app.js              viewer runtime: pan/zoom, hover highlighting, tooltips, engine switching
  graph-data.js       node metadata for tooltips
```

Edge semantics: `func → var` = write, `var → func` = read, `↔` = read+write, dashed = call. Every node is clickable and navigates to its page. If the whole program is too big for one readable diagram (>130 nodes), the overview collapses to a file-level graph with aggregated edge counts. The level-0 diagram shows only variables actually *exchanged* between entry points (written in one entry's call tree, read in another's); entry points that reach the same peripheral, and peripherals whose name matches an ISR, are shown too. Solid vs. dashed still means direct vs. via-the-call-tree access; a dashed edge labeled "взводит" is an `NVIC_EnableIRQ` call, a thick edge labeled "прерывание" is the peripheral's hardware vector firing that handler. Variables that share the exact same set of writers and readers are bundled into one "data channel" node instead of one node each — capped at the 50 most-used channels and 40 most-used peripherals.

A file's own diagram always shows every one of its own functions and globals in full, plus dashed "ghost" nodes for everything one step outside the file (a neighboring file's function that calls into or is called from this one, a variable this file touches that's defined elsewhere) — nothing is folded away or hidden behind a click.

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

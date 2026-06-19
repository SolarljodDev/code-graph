# code-graph-vault

Parses a C codebase (`inc`/`src` layout) directly with [tree-sitter](https://tree-sitter.github.io/tree-sitter/) and generates an [Obsidian](https://obsidian.md/) vault containing two graphs:

- **Files graph** — nodes are source files, edges are `#include` relationships.
- **Whole-program call graph** — nodes are functions (qualified as `name__file` when the same name is defined in multiple files, e.g. static helpers), edges are function calls resolved across the entire merged codebase. Calls that resolve to nothing in the codebase (library/macro calls, e.g. CMSIS intrinsics) are linked as separate `external` stub notes.

No external pipeline or pre-built knowledge graph is required — it walks the given directories and parses the C source itself.

## Usage

```
npm install
node index.mjs <outDir> <sourceRoot1> [<sourceRoot2> ...]
```

Or, from any directory, using the bundled wrapper:

```
"<path-to-this-repo>\graph.cmd" <outDir> <sourceRoot1> [<sourceRoot2> ...]
```

Open `<outDir>` as an Obsidian vault. In Graph View, filter by:

- `path:Files` — file include graph
- `path:Functions -path:_external` — call graph, internal calls only
- `path:Functions` — call graph including external/library calls as leaf nodes

Use Graph View "Groups" to color nodes by tag (`function`, `external`, `file`, `module/...`).

## Setup on a new machine

`tree-sitter` and `tree-sitter-c` ship prebuilt native binaries (via `node-gyp-build`/`prebuildify`, N-API based) for win32-x64, linux-x64, darwin-x64/arm64. On a matching platform, `npm install` just downloads the prebuilt binary — no compiler toolchain needed. Only Node.js itself is required.

## Known fix baked in

`node-tree-sitter` 0.21.x throws `Invalid argument` when parsing a single string buffer of 32768+ UTF-16 code units. This script reads files through a chunked callback (16 KB chunks) instead of passing the whole file as one string, which avoids the bug — relevant for large generated headers (e.g. CMSIS device headers).

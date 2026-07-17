// Shared WASM runtime init — web-tree-sitter (parser + C grammar) and
// graphviz-wasm — used by every analyzer module (cfg-analyzer.mjs,
// level0-analyzer.mjs, ...). Both are dynamically import()-ed from the same
// absolute path by extension.js's CJS host, so Node's ESM module cache
// dedupes this module across them: whichever analyzer initializes first pays
// the WASM load cost, the other reuses the same singletons.

import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

let Parser = null;
let CLang = null;
let graphviz = null;

export async function ensureWasmRuntime({ wasmDir }) {
  if (!Parser) {
    // web-tree-sitter 0.21.x: CJS default export, Parser.Language.load.
    const TS = require('web-tree-sitter');
    await TS.init({
      locateFile: (name) => path.join(wasmDir, name), // finds tree-sitter.wasm
    });
    Parser = TS;
  }
  if (!CLang) {
    CLang = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-c.wasm'));
  }
  if (!graphviz) {
    const { Graphviz } = await import('@hpcc-js/wasm-graphviz');
    graphviz = await Graphviz.load();
  }
}

export function newCParser() {
  const parser = new Parser();
  parser.setLanguage(CLang);
  return parser;
}

export function getGraphviz() {
  return graphviz;
}

// chunked reader — avoids the >32K UTF-16 single-buffer issue node-tree-sitter
// (and, empirically, web-tree-sitter too) hits on a plain string argument.
export function parseC(src) {
  const parser = newCParser();
  return parser.parse((index) => {
    const chunk = src.slice(index, index + 16384);
    return chunk.length ? chunk : null;
  });
}

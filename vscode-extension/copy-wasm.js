// Copies the two WASM blobs the analyzer needs into ./wasm so the extension
// has a stable, self-contained location to load them from (independent of
// node_modules layout). Runs on postinstall; safe to run by hand.
const fs = require('fs');
const path = require('path');

const wasmDir = path.join(__dirname, 'wasm');
fs.mkdirSync(wasmDir, { recursive: true });

const copies = [
  ['node_modules/web-tree-sitter/tree-sitter.wasm', 'tree-sitter.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-c.wasm', 'tree-sitter-c.wasm'],
];

for (const [from, to] of copies) {
  const src = path.join(__dirname, from);
  const dst = path.join(wasmDir, to);
  if (!fs.existsSync(src)) {
    console.error(`copy-wasm: missing ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dst);
  console.log(`copy-wasm: ${to}`);
}

// Headless smoke test for cfg-analyzer.mjs against a real CORE file.
// Run: node test-analyzer.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initAnalyzer, analyzeAllFunctions } from './src/cfg-analyzer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.join(here, 'wasm');

const target = path.resolve(here, '..', 'CORE', 'user', 'src', 'dwin.c');
const src = fs.readFileSync(target, 'utf-8');

await initAnalyzer({ wasmDir });

const { functions } = analyzeAllFunctions(src);
console.log(`dwin.c: ${src.split('\n').length} lines, ${functions.length} functions\n`);

const byKind = {};
for (const f of functions) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
console.log('by kind:', byKind);

let svgBytes = 0, idMiss = 0, rangeBad = 0, order = true, prev = -1;
for (const f of functions) {
  if (f.funcRange.startLine < prev) order = false;
  prev = f.funcRange.startLine;
  if (f.kind !== 'cfg') continue;
  svgBytes += f.svg.length;
  for (const n of f.nodeLines) {
    if (!f.svg.includes(`id="${n.id}"`)) idMiss++;
    if (n.startLine < f.funcRange.startLine || n.endLine > f.funcRange.endLine) rangeBad++;
  }
  for (const e of f.edges) {
    if (!f.svg.includes(`id="${e.id}"`)) idMiss++;
  }
}
console.log(`combined svg: ${Math.round(svgBytes / 1024)}KB`);
console.log(`source order preserved: ${order}`);
console.log(`node/edge ids missing from their svg: ${idMiss}`);
console.log(`node line-ranges outside their function: ${rangeBad}`);

console.log('\nfirst 6 blocks:');
for (const f of functions.slice(0, 6)) {
  console.log(
    `  ${f.functionName.padEnd(22)} ${f.kind.padEnd(8)} lines ${f.funcRange.startLine}-${f.funcRange.endLine}` +
    ` nodes=${f.nodeLines.length}`
  );
}

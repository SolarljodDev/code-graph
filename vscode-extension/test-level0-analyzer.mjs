// Headless smoke test for level0-analyzer.mjs against the real CORE project.
// Run: node test-level0-analyzer.mjs
//
// Uses plain fs/walkDir over ../CORE, not vscode.workspace.findFiles — this
// is exactly why level0-analyzer.mjs never imports 'vscode'.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initAnalyzer, buildLevel0 } from './src/level0-analyzer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.join(here, 'wasm');
const coreRoot = path.resolve(here, '..', 'CORE');

function walkDir(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'graph-html' || entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') continue;
      walkDir(full, exts, out);
    } else if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const filePaths = walkDir(coreRoot, ['.c', '.h']);
const files = filePaths.map(filePath => ({ filePath, text: fs.readFileSync(filePath, 'utf-8') }));
console.log(`scanning ${files.length} files under ${coreRoot}`);

await initAnalyzer({ wasmDir });

const level0 = await buildLevel0({ files });
if (!level0) {
  console.error('buildLevel0 returned null — no main/ISR found?');
  process.exit(1);
}

const svgKeys = Object.keys(level0.svgs).sort();
console.log(`\nsvg variants (${svgKeys.length}): ${svgKeys.join(', ')}`);
console.log(`varsToggle: ${level0.varsToggle}, cyclicToggle: ${level0.cyclicToggle}`);
if (level0.note) console.log(`note: ${level0.note}`);

const entryNodes = Object.entries(level0.nodeInfo).filter(([, v]) => v.kind === 'entry' || v.kind === 'isr');
console.log(`\nentry/ISR nodes: ${entryNodes.length}`);
let missingPos = 0;
for (const [id, info] of entryNodes) {
  if (typeof info.startLine !== 'number' || !info.filePath) missingPos++;
}
console.log(`entry/ISR nodes missing file/startLine: ${missingPos}`);

const periphNodes = Object.entries(level0.nodeInfo).filter(([, v]) => v.kind === 'periph');
const varNodes = Object.entries(level0.nodeInfo).filter(([, v]) => v.kind !== 'periph' && v.kind !== 'entry' && v.kind !== 'isr');
let leakedNavTarget = 0;
for (const [, info] of [...periphNodes, ...varNodes]) {
  if (typeof info.startLine === 'number') leakedNavTarget++;
}
console.log(`peripheral/var nodes: ${periphNodes.length + varNodes.length}, with a leaked navigate target: ${leakedNavTarget}`);

// every node id referenced by a g.node in the default 'neato' svg should
// have a nodeInfo entry (the inverse check test-analyzer.mjs does for CFG
// node/edge ids vs their own svg).
const mainSvg = level0.svgs.neato || '';
const idRe = /<g id="([^"]+)" class="node[^"]*">/g;
let svgNodeCount = 0, infoMiss = 0;
let m;
while ((m = idRe.exec(mainSvg))) {
  svgNodeCount++;
  if (!level0.nodeInfo[m[1]]) infoMiss++;
}
console.log(`\ndefault svg 'neato': ${svgNodeCount} nodes, missing nodeInfo: ${infoMiss}`);

console.log('\nfirst 10 entry/ISR nodes:');
for (const [id, info] of entryNodes.slice(0, 10)) {
  console.log(`  ${info.label.padEnd(24)} ${info.kind.padEnd(6)} ${info.file}:${info.startLine}`);
}

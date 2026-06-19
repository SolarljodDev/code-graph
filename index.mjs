import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

// Usage: node index.mjs <outDir> <sourceRoot1> [<sourceRoot2> ...]
const [outDir, ...roots] = process.argv.slice(2);
if (!outDir || roots.length === 0) {
  console.error('Usage: node index.mjs <outDir> <sourceRoot1> [<sourceRoot2> ...]');
  process.exit(1);
}

const parser = new Parser();
parser.setLanguage(C);

function walkDir(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, exts, out);
    else if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function walkTree(node, cb) {
  cb(node);
  for (const child of node.children) walkTree(child, cb);
}

function findNameInDeclarator(node) {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  const inner = node.childForFieldName('declarator');
  if (inner) return findNameInDeclarator(inner);
  for (const child of node.children) {
    const found = findNameInDeclarator(child);
    if (found) return found;
  }
  return null;
}

function extractIncludes(root) {
  const includes = [];
  walkTree(root, node => {
    if (node.type === 'preproc_include') {
      const target = node.namedChildren.find(
        c => c.type === 'string_literal' || c.type === 'system_lib_string',
      );
      if (target) {
        const raw = target.text.replace(/^["<]|[">]$/g, '');
        includes.push({ raw, isSystem: target.type === 'system_lib_string' });
      }
    }
  });
  return includes;
}

function extractFunctions(root) {
  const funcs = [];
  walkTree(root, node => {
    if (node.type === 'function_definition') {
      const declarator = node.childForFieldName('declarator');
      const name = findNameInDeclarator(declarator);
      if (name) funcs.push({ name, node });
    }
  });
  return funcs;
}

function extractCalls(funcNode) {
  const body = funcNode.childForFieldName('body');
  const calls = [];
  if (!body) return calls;
  walkTree(body, node => {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (fn && fn.type === 'identifier') calls.push(fn.text);
    }
  });
  return calls;
}

// --- Pass 1: parse every file ---
const exts = ['.c', '.h'];
const allFiles = roots.flatMap(r => walkDir(path.resolve(r), exts));

const fileRecords = [];
const functionsByName = new Map();

for (const filePath of allFiles) {
  const src = fs.readFileSync(filePath, 'utf-8');
  let tree;
  try {
    // node-tree-sitter chokes on single buffers >= 32768 UTF-16 units when
    // passed as a plain string; feeding it via a chunked reader avoids that.
    tree = parser.parse((index) => {
      const chunk = src.slice(index, index + 16384);
      return chunk.length ? chunk : null;
    });
  } catch (e) {
    console.error(`parse failed: ${filePath}: ${e.message}`);
    continue;
  }
  const root = tree.rootNode;
  const basename = path.basename(filePath);
  const includes = extractIncludes(root);
  const funcs = extractFunctions(root).map(f => ({
    name: f.name,
    calls: extractCalls(f.node),
  }));

  fileRecords.push({ filePath, basename, includes, funcs });
  for (const f of funcs) {
    if (!functionsByName.has(f.name)) functionsByName.set(f.name, []);
    functionsByName.get(f.name).push({ basename, filePath });
  }
}

const basenameToFiles = new Map();
for (const f of fileRecords) {
  if (!basenameToFiles.has(f.basename)) basenameToFiles.set(f.basename, []);
  basenameToFiles.get(f.basename).push(f);
}

function qualifiedFuncFilename(name, basename) {
  const candidates = functionsByName.get(name) || [];
  if (candidates.length <= 1) return `${name}.md`;
  return `${name}__${basename.replace(/\.[ch]$/, '')}.md`;
}

// --- Write vault ---
const filesDir = path.join(outDir, 'Files');
const funcsDir = path.join(outDir, 'Functions');
const externalDir = path.join(outDir, 'Functions', '_external');
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(funcsDir, { recursive: true });
fs.mkdirSync(externalDir, { recursive: true });

const externalSeen = new Set();
let edgeCountFiles = 0;
let edgeCountFuncs = 0;

for (const f of fileRecords) {
  const moduleName = path.basename(path.dirname(path.dirname(f.filePath)));
  const lines = [
    '---',
    `tags: [file, "module/${moduleName}"]`,
    '---',
    '',
    `# ${f.basename}`,
    '',
    `*${f.filePath}*`,
    '',
    '## Includes',
  ];
  if (f.includes.length === 0) {
    lines.push('- *(none)*');
  }
  for (const inc of f.includes) {
    const resolved = basenameToFiles.get(inc.raw);
    if (resolved) {
      lines.push(`- [[${inc.raw}]]`);
      edgeCountFiles++;
    } else {
      lines.push(`- *${inc.raw}* (external header)`);
    }
  }
  lines.push('', '## Functions defined here');
  if (f.funcs.length === 0) lines.push('- *(none)*');
  for (const fn of f.funcs) {
    lines.push(`- [[${qualifiedFuncFilename(fn.name, f.basename).replace(/\.md$/, '')}]]`);
  }
  fs.writeFileSync(path.join(filesDir, `${f.basename}.md`), lines.join('\n') + '\n');
}

for (const f of fileRecords) {
  for (const fn of f.funcs) {
    const noteFile = qualifiedFuncFilename(fn.name, f.basename);
    const lines = [
      '---',
      `tags: [function, "file/${f.basename}"]`,
      '---',
      '',
      `# ${fn.name}`,
      '',
      `*defined in [[${f.basename}]]*`,
      '',
      '## Calls',
    ];
    const internal = [];
    const external = [];
    for (const calleeName of fn.calls) {
      const candidates = functionsByName.get(calleeName);
      if (candidates && candidates.length > 0) {
        const sameFile = candidates.find(c => c.basename === f.basename);
        const target = sameFile || candidates[0];
        internal.push(qualifiedFuncFilename(calleeName, target.basename).replace(/\.md$/, ''));
      } else {
        external.push(calleeName);
      }
    }
    if (internal.length === 0 && external.length === 0) lines.push('- *(none)*');
    for (const link of [...new Set(internal)]) {
      lines.push(`- [[${link}]]`);
      edgeCountFuncs++;
    }
    for (const ext of [...new Set(external)]) {
      lines.push(`- [[${ext}]] *(external/library)*`);
      edgeCountFuncs++;
      if (!externalSeen.has(ext)) {
        externalSeen.add(ext);
        fs.writeFileSync(
          path.join(externalDir, `${ext}.md`),
          ['---', 'tags: [external]', '---', '', `# ${ext}`, '', '*Library/macro call not defined in this codebase.*', ''].join('\n'),
        );
      }
    }
    fs.writeFileSync(path.join(funcsDir, noteFile), lines.join('\n') + '\n');
  }
}

fs.writeFileSync(
  path.join(outDir, 'README.md'),
  [
    '# Code Graph Vault',
    '',
    `Generated from: ${roots.map(r => path.resolve(r)).join(', ')}`,
    '',
    `Files: ${fileRecords.length}, Functions: ${[...functionsByName.values()].flat().length}, Include edges: ${edgeCountFiles}, Call edges: ${edgeCountFuncs}, External calls referenced: ${externalSeen.size}`,
    '',
    'Open this folder as an Obsidian vault. In Graph View, use the filter box:',
    '- `path:Files` for the file-include graph',
    '- `path:Functions -path:_external` for the whole-program function call graph (internal only)',
    '- `path:Functions` to include external/library calls as leaf nodes',
    '',
    'Use Graph View "Groups" to color by tag (`function`, `external`, `file`, `module/...`).',
  ].join('\n') + '\n',
);

console.log(`Files: ${fileRecords.length}`);
console.log(`Functions: ${[...functionsByName.values()].flat().length}`);
console.log(`Include edges: ${edgeCountFiles}`);
console.log(`Call edges: ${edgeCountFuncs} (external refs: ${externalSeen.size})`);
console.log(`Vault written to: ${path.resolve(outDir)}`);

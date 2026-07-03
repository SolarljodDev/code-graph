import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

// ---------------------------------------------------------------------------
// Generic tree helpers
// ---------------------------------------------------------------------------

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

function childrenForField(node, field) {
  const out = [];
  const cursor = node.walk();
  if (cursor.gotoFirstChild()) {
    do {
      if (cursor.currentFieldName === field) out.push(cursor.currentNode);
    } while (cursor.gotoNextSibling());
  }
  return out;
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

// node-tree-sitter returns a fresh wrapper object on every accessor call, so
// two references to the same syntax node are never `===`; compare .id instead.
const sameNode = (a, b) => !!a && !!b && a.id === b.id;

function insideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'function_definition') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

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

// --- doc comments -----------------------------------------------------------
// Convention: a description belongs to a declaration only if it is *adjacent* —
// either a trailing comment on the same line, or comment line(s) directly
// above with no blank line in between. A comment that shares its line with
// code (trailing comment of the previous statement) is never picked up.

function cleanComment(text) {
  const lines = text.split('\n').map(l =>
    l.replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '')
     .replace(/^\s*\/\/+/, '').replace(/^\s*\*+(?!\/)/, '').trim(),
  ).filter(l => l && !/^[=\-_~*#+.\s]+$/.test(l));
  return lines.join(' ').replace(/\s+/g, ' ')
    .replace(/^[@\\]brief\s*/i, '').trim();
}

function buildCommentIndex(root, srcLines) {
  const byEndRow = new Map();
  const byStartRow = new Map();
  walkTree(root, n => {
    if (n.type !== 'comment') return;
    byStartRow.set(n.startPosition.row, n);
    // only "own-line" comments may serve as a preceding description
    const before = (srcLines[n.startPosition.row] || '').slice(0, n.startPosition.column);
    if (before.trim() === '') byEndRow.set(n.endPosition.row, n);
  });
  return { byEndRow, byStartRow };
}

function docCommentFor(node, idx, { allowTrailing = false } = {}) {
  if (allowTrailing) {
    const t = idx.byStartRow.get(node.endPosition.row);
    if (t && t.startIndex >= node.endIndex) {
      const s = cleanComment(t.text);
      if (s) return s;
    }
  }
  const parts = [];
  let row = node.startPosition.row - 1;
  while (parts.length < 8) {
    const c = idx.byEndRow.get(row);
    if (!c) break;
    parts.unshift(c.text);
    row = c.startPosition.row - 1;
  }
  // a run of // lines containing a decorative rule (// ====) is a section
  // banner for the code below, not a description of this one declaration
  if (parts.length && parts.every(p => p.startsWith('//'))) {
    const hasRule = parts.some(p => {
      const t = p.replace(/^\/\/+/, '').trim();
      return t !== '' && /^[=\-_~*#+.]+$/.test(t);
    });
    if (hasRule) return '';
  }
  return cleanComment(parts.join('\n'));
}

// A declarator declares a *function* (prototype) when, after unwrapping
// pointers/arrays, we hit a function_declarator whose own declarator is a
// bare identifier. `void (*cb)(void)` is a function-pointer VARIABLE: there
// the function_declarator wraps a parenthesized_declarator instead.
function isFunctionDeclarator(decl) {
  let d = decl;
  if (d && d.type === 'init_declarator') d = d.childForFieldName('declarator');
  while (d) {
    if (d.type === 'function_declarator') {
      const inner = d.childForFieldName('declarator');
      return !!inner && inner.type === 'identifier';
    }
    if (d.type === 'pointer_declarator' || d.type === 'array_declarator') {
      d = d.childForFieldName('declarator');
      continue;
    }
    if (d.type === 'parenthesized_declarator') return false;
    break;
  }
  return false;
}

function typeTextOf(declNode) {
  const t = declNode.childForFieldName('type');
  if (!t) return '';
  let text = t.text.replace(/\s+/g, ' ');
  if (text.length > 28) text = text.slice(0, 25) + '...';
  return text;
}

// File-scope variables: definitions and extern declarations.
function extractFileScopeVars(root, commentIdx) {
  const defs = [];
  const externs = [];
  walkTree(root, node => {
    if (node.type !== 'declaration' || insideFunction(node)) return;
    const storage = node.namedChildren
      .filter(c => c.type === 'storage_class_specifier')
      .map(c => c.text);
    if (storage.includes('typedef')) return;
    const isExtern = storage.includes('extern');
    const isStatic = storage.includes('static');
    const isVolatile = /\bvolatile\b/.test(node.text.split('=')[0]);
    const typeText = typeTextOf(node);
    const desc = docCommentFor(node, commentIdx, { allowTrailing: true });
    for (const d of childrenForField(node, 'declarator')) {
      if (isFunctionDeclarator(d)) continue;
      const name = findNameInDeclarator(d);
      if (!name) continue;
      (isExtern ? externs : defs).push({ name, isStatic, isVolatile, typeText, desc });
    }
  });
  return { defs, externs };
}

// How is this identifier used: read, write, or both?
function classifyAccess(id) {
  let n = id;
  while (n.parent) {
    const p = n.parent;
    if (p.type === 'assignment_expression') {
      if (sameNode(p.childForFieldName('left'), n)) {
        const opNode = p.children.find(c => !c.isNamed && c.text.endsWith('='));
        return opNode && opNode.text !== '=' ? 'rw' : 'w';
      }
      return 'r';
    }
    if (p.type === 'update_expression') return 'rw'; // ++ / --
    if (p.type === 'pointer_expression') {
      const op = p.children[0] ? p.children[0].text : '*';
      // &x: address escapes, assume read+write; *p: the pointer itself is read
      return op === '&' ? 'rw' : 'r';
    }
    if (p.type === 'subscript_expression') {
      if (sameNode(p.childForFieldName('argument'), n)) { n = p; continue; }
      return 'r'; // inside the [index]
    }
    if (p.type === 'field_expression') {
      if (sameNode(p.childForFieldName('argument'), n)) { n = p; continue; }
      return 'r';
    }
    if (p.type === 'parenthesized_expression') { n = p; continue; }
    return 'r';
  }
  return 'r';
}

function analyzeFunction(funcNode) {
  const declarator = funcNode.childForFieldName('declarator');
  const locals = new Set();
  if (declarator) {
    walkTree(declarator, n => {
      if (n.type === 'parameter_declaration') {
        const nm = findNameInDeclarator(n.childForFieldName('declarator'));
        if (nm) locals.add(nm);
      }
    });
  }
  const body = funcNode.childForFieldName('body');
  if (body) {
    walkTree(body, n => {
      if (n.type === 'declaration') {
        for (const d of childrenForField(n, 'declarator')) {
          const nm = findNameInDeclarator(d);
          if (nm) locals.add(nm);
        }
      }
    });
  }

  const calls = new Set();
  const access = new Map(); // name -> { r, w }
  if (body) {
    walkTree(body, n => {
      if (n.type === 'call_expression') {
        const fn = n.childForFieldName('function');
        if (fn && fn.type === 'identifier') calls.add(fn.text);
        return;
      }
      if (n.type !== 'identifier') return;
      const p = n.parent;
      if (p && p.type === 'call_expression' && sameNode(p.childForFieldName('function'), n)) return;
      if (p && p.type === 'field_expression' && sameNode(p.childForFieldName('field'), n)) return;
      // skip the *declared name* itself, but not initializer values / array sizes
      if (p && (p.type.endsWith('_declarator')) && sameNode(p.childForFieldName('declarator'), n)) return;
      const name = n.text;
      if (locals.has(name)) return;
      const mode = classifyAccess(n);
      const cur = access.get(name) || { r: false, w: false };
      if (mode.includes('r')) cur.r = true;
      if (mode.includes('w')) cur.w = true;
      access.set(name, cur);
    });
  }

  const typeNode = funcNode.childForFieldName('type');
  const signature = `${typeNode ? typeNode.text + ' ' : ''}${declarator ? declarator.text : ''}`
    .replace(/\s+/g, ' ');
  return { calls, access, signature };
}

// ---------------------------------------------------------------------------
// Control-flow graph (flowchart) of a function body.
// Consecutive plain statements are merged into one block; statements that call
// a function stand alone (they become clickable). Conditions and loops become
// diamonds with labeled branches; return/break/continue/goto are routed.
// ---------------------------------------------------------------------------

const CFG_MAX_NODES = 200;

function buildCfg(body) {
  if (!body) return null;
  const nodes = [];
  const edges = [];
  let seq = 0;

  const mkNode = (kind, label, calls = []) => {
    const id = 'c' + seq++;
    nodes.push({ id, kind, label, calls });
    return id;
  };
  const mkEdge = (from, to, label) => { edges.push({ from, to, label: label || '' }); };
  const attach = (pending, id) => { for (const p of pending) mkEdge(p.from, id, p.label); };

  const trunc = (s, n = 40) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const callNames = n => {
    const out = [];
    walkTree(n, x => {
      if (x.type === 'call_expression') {
        const f = x.childForFieldName('function');
        if (f && f.type === 'identifier') out.push(f.text);
      }
    });
    return out;
  };

  const labelIds = new Map(); // label name -> node id
  const gotos = [];           // { from, name }
  const SIMPLE = new Set(['expression_statement', 'declaration']);

  function buildSeq(stmts, ctx) {
    let entry = null;
    let pending = []; // dangling exits waiting for the next node
    let alive = true;
    let blockLines = [];

    const flushBlock = () => {
      if (!blockLines.length) return;
      const shown = blockLines.slice(0, 4);
      if (blockLines.length > 4) shown.push('…');
      const id = mkNode('stmt', shown.join('\n'));
      if (!entry) entry = id;
      attach(pending, id);
      pending = [{ from: id }];
      blockLines = [];
    };

    for (const s of stmts) {
      if (!alive) break; // unreachable after return/break/continue
      if (s.type === 'comment') continue;
      if (SIMPLE.has(s.type)) {
        const calls = callNames(s);
        if (calls.length) {
          flushBlock();
          const id = mkNode('call', trunc(s.text, 46), calls);
          if (!entry) entry = id;
          attach(pending, id);
          pending = [{ from: id }];
        } else {
          blockLines.push(trunc(s.text));
        }
        continue;
      }
      flushBlock();
      const r = buildStmt(s, ctx);
      if (r && r.entry) {
        if (!entry) entry = r.entry;
        attach(pending, r.entry);
        pending = r.exits;
        if (!r.exits.length) alive = false;
      }
    }
    flushBlock();
    return { entry, exits: pending };
  }

  function buildAny(s, ctx) {
    if (!s) return null;
    if (SIMPLE.has(s.type)) {
      const calls = callNames(s);
      const id = mkNode(calls.length ? 'call' : 'stmt', trunc(s.text, 46), calls);
      return { entry: id, exits: [{ from: id }] };
    }
    return buildStmt(s, ctx);
  }

  function buildStmt(s, ctx) {
    switch (s.type) {
      case 'compound_statement':
        return buildSeq(s.namedChildren, ctx);

      case 'if_statement': {
        const cond = mkNode('cond', trunc('if ' + (s.childForFieldName('condition')?.text ?? '')));
        const exits = [];
        const cr = buildAny(s.childForFieldName('consequence'), ctx);
        if (cr && cr.entry) { mkEdge(cond, cr.entry, 'да'); exits.push(...cr.exits); }
        else exits.push({ from: cond, label: 'да' });
        const altClause = s.childForFieldName('alternative'); // else_clause
        if (altClause) {
          const ar = buildAny(altClause.namedChildren[0], ctx);
          if (ar && ar.entry) { mkEdge(cond, ar.entry, 'нет'); exits.push(...ar.exits); }
          else exits.push({ from: cond, label: 'нет' });
        } else {
          exits.push({ from: cond, label: 'нет' });
        }
        return { entry: cond, exits };
      }

      case 'while_statement': {
        const cond = mkNode('loop', trunc('while ' + (s.childForFieldName('condition')?.text ?? '')));
        const breaks = [];
        const br = buildAny(s.childForFieldName('body'), { ...ctx, breaks, continueTo: cond });
        if (br && br.entry) {
          mkEdge(cond, br.entry, 'да');
          for (const e of br.exits) mkEdge(e.from, cond, e.label);
        }
        return { entry: cond, exits: [{ from: cond, label: 'нет' }, ...breaks] };
      }

      case 'do_statement': {
        const breaks = [];
        const cond = mkNode('loop', trunc('while ' + (s.childForFieldName('condition')?.text ?? '')));
        const br = buildAny(s.childForFieldName('body'), { ...ctx, breaks, continueTo: cond });
        let entry = cond;
        if (br && br.entry) {
          entry = br.entry;
          for (const e of br.exits) mkEdge(e.from, cond, e.label);
          mkEdge(cond, br.entry, 'да');
        }
        return { entry, exits: [{ from: cond, label: 'нет' }, ...breaks] };
      }

      case 'for_statement': {
        const bodyNode = s.childForFieldName('body');
        const header = bodyNode ? s.text.slice(0, bodyNode.startIndex - s.startIndex) : s.text;
        const cond = mkNode('loop', trunc(header, 46));
        const breaks = [];
        const br = buildAny(bodyNode, { ...ctx, breaks, continueTo: cond });
        if (br && br.entry) {
          mkEdge(cond, br.entry, 'цикл');
          for (const e of br.exits) mkEdge(e.from, cond, e.label);
        }
        return { entry: cond, exits: [{ from: cond, label: 'конец' }, ...breaks] };
      }

      case 'switch_statement': {
        const sw = mkNode('cond', trunc('switch ' + (s.childForFieldName('condition')?.text ?? '')));
        const breaks = [];
        const bodyNode = s.childForFieldName('body');
        let fall = []; // fallthrough exits of the previous case
        let sawDefault = false;
        const cases = bodyNode ? bodyNode.namedChildren.filter(c => c.type === 'case_statement') : [];
        for (const cs of cases) {
          const valNode = cs.childForFieldName('value');
          const lbl = valNode ? trunc(valNode.text, 20) : 'default';
          if (!valNode) sawDefault = true;
          const stmts = cs.namedChildren.filter(c => !valNode || c.id !== valNode.id);
          const r = buildSeq(stmts, { ...ctx, breaks });
          if (r.entry) {
            mkEdge(sw, r.entry, lbl);
            attach(fall, r.entry);
            fall = r.exits;
          } else {
            fall.push({ from: sw, label: lbl }); // empty case falls through
          }
        }
        const exits = [...breaks, ...fall];
        if (!sawDefault) exits.push({ from: sw, label: 'иначе' });
        return { entry: sw, exits };
      }

      case 'return_statement': {
        const id = mkNode('ret', trunc(s.text, 42));
        mkEdge(id, ctx.exitId);
        return { entry: id, exits: [] };
      }

      case 'break_statement': {
        const id = mkNode('jump', 'break');
        if (ctx.breaks) ctx.breaks.push({ from: id });
        return { entry: id, exits: [] };
      }

      case 'continue_statement': {
        const id = mkNode('jump', 'continue');
        if (ctx.continueTo) mkEdge(id, ctx.continueTo, '↩');
        return { entry: id, exits: [] };
      }

      case 'labeled_statement': {
        const name = s.childForFieldName('label')?.text ?? '';
        const id = mkNode('stmt', name + ':');
        labelIds.set(name, id);
        const inner = s.namedChildren.find(c => c.type !== 'statement_identifier');
        const r = inner ? buildAny(inner, ctx) : null;
        if (r && r.entry) { mkEdge(id, r.entry); return { entry: id, exits: r.exits }; }
        return { entry: id, exits: [{ from: id }] };
      }

      case 'goto_statement': {
        const name = s.childForFieldName('label')?.text ?? '';
        const id = mkNode('jump', 'goto ' + name);
        gotos.push({ from: id, name });
        return { entry: id, exits: [] };
      }

      default: {
        const calls = callNames(s);
        const id = mkNode(calls.length ? 'call' : 'stmt', trunc(s.text, 46), calls);
        return { entry: id, exits: [{ from: id }] };
      }
    }
  }

  const startId = mkNode('term', 'начало');
  const exitId = mkNode('term', 'конец');
  const r = buildSeq(body.namedChildren, { exitId, breaks: null, continueTo: null });
  if (r.entry) mkEdge(startId, r.entry); else mkEdge(startId, exitId);
  for (const e of r.exits) mkEdge(e.from, exitId, e.label);
  for (const g of gotos) if (labelIds.has(g.name)) mkEdge(g.from, labelIds.get(g.name), 'goto');

  if (nodes.length > CFG_MAX_NODES) return null; // too big to be readable
  if (nodes.length <= 3) return null;            // trivial body
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Pass 1: parse every file
// ---------------------------------------------------------------------------

const exts = ['.c', '.h'];
const allFiles = roots.flatMap(r => walkDir(path.resolve(r), exts));

const fileRecords = [];

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
  const commentIdx = buildCommentIndex(root, src.split('\n'));
  const includes = extractIncludes(root);
  const vars = extractFileScopeVars(root, commentIdx);
  const funcs = extractFunctions(root).map(f => ({
    name: f.name,
    desc: docCommentFor(f.node, commentIdx),
    cfg: buildCfg(f.node.childForFieldName('body')),
    ...analyzeFunction(f.node),
  }));
  fileRecords.push({ filePath, basename, includes, funcs, vars });
}

// ---------------------------------------------------------------------------
// Pass 2: build the model (resolve names across files)
// ---------------------------------------------------------------------------

const functionsByName = new Map(); // name -> [fileRecord]
for (const f of fileRecords) {
  for (const fn of f.funcs) {
    if (!functionsByName.has(fn.name)) functionsByName.set(fn.name, []);
    functionsByName.get(fn.name).push(f);
  }
}

function funcKey(name, basename) {
  const candidates = functionsByName.get(name) || [];
  if (candidates.length <= 1) return name;
  return `${name}__${basename.replace(/\.[ch]$/, '')}`;
}

const ISR_RE = /(_IRQHandler|_Handler|_ISR)$|^ISR_/;

const varDefs = new Map();   // varKey -> var record
const varByName = new Map(); // name -> [varKey]
const externNames = new Set();

for (const f of fileRecords) {
  for (const v of f.vars.defs) {
    const key = v.isStatic ? `${v.name}@${f.basename}` : v.name;
    if (!varDefs.has(key)) {
      varDefs.set(key, {
        key, name: v.name, file: f.basename,
        isStatic: v.isStatic, isVolatile: v.isVolatile, typeText: v.typeText,
        desc: v.desc || '',
        readers: new Set(), writers: new Set(),
      });
      if (!varByName.has(v.name)) varByName.set(v.name, []);
      varByName.get(v.name).push(key);
    } else {
      const rec = varDefs.get(key);
      if (v.isVolatile) rec.isVolatile = true;
      if (!rec.desc && v.desc) rec.desc = v.desc;
    }
  }
  for (const v of f.vars.externs) externNames.add(v.name);
}

const funcs = new Map(); // funcKey -> func record

for (const f of fileRecords) {
  for (const fn of f.funcs) {
    const key = funcKey(fn.name, f.basename);
    const rec = {
      key, name: fn.name, file: f.basename, signature: fn.signature,
      desc: fn.desc || '', cfg: fn.cfg,
      isISR: ISR_RE.test(fn.name), isEntry: fn.name === 'main',
      calls: new Set(),      // funcKeys
      extCalls: new Set(),   // bare names
      callers: new Set(),    // funcKeys, filled below
      access: new Map(),     // varKey -> 'r' | 'w' | 'rw'
    };
    funcs.set(key, rec);
  }
}

function resolveVar(name, basename) {
  const keys = varByName.get(name);
  if (!keys) return null;
  const staticLocal = keys.find(k => k === `${name}@${basename}`);
  if (staticLocal) return staticLocal;
  const nonStatic = keys.find(k => k === name);
  return nonStatic || keys[0];
}

for (const f of fileRecords) {
  for (const fn of f.funcs) {
    const rec = funcs.get(funcKey(fn.name, f.basename));

    for (const calleeName of fn.calls) {
      const candidates = functionsByName.get(calleeName);
      if (candidates && candidates.length > 0) {
        const target = candidates.find(c => c.basename === f.basename) || candidates[0];
        const calleeKey = funcKey(calleeName, target.basename);
        if (calleeKey !== rec.key) rec.calls.add(calleeKey);
      } else {
        rec.extCalls.add(calleeName);
      }
    }

    for (const [name, mode] of fn.access) {
      const varKey = resolveVar(name, f.basename);
      if (varKey) {
        const v = varDefs.get(varKey);
        const m = (mode.r ? 'r' : '') + (mode.w ? 'w' : '');
        const prev = rec.access.get(varKey);
        rec.access.set(varKey, prev && prev !== m ? 'rw' : (m || 'r'));
        if (mode.r) v.readers.add(rec.key);
        if (mode.w) v.writers.add(rec.key);
        continue;
      }
      if (functionsByName.has(name)) {
        // function used as a value (callback / function pointer) => call edge
        const target = functionsByName.get(name).find(c => c.basename === f.basename)
          || functionsByName.get(name)[0];
        const calleeKey = funcKey(name, target.basename);
        if (calleeKey !== rec.key) rec.calls.add(calleeKey);
        continue;
      }
      if (externNames.has(name)) {
        // extern-declared but never defined in the scanned sources
        const key = `extern:${name}`;
        if (!varDefs.has(key)) {
          varDefs.set(key, {
            key, name, file: null, isStatic: false, isVolatile: false,
            typeText: '', desc: '', isExternal: true, readers: new Set(), writers: new Set(),
          });
        }
        const v = varDefs.get(key);
        const m = (mode.r ? 'r' : '') + (mode.w ? 'w' : '');
        const prev = rec.access.get(key);
        rec.access.set(key, prev && prev !== m ? 'rw' : (m || 'r'));
        if (mode.r) v.readers.add(rec.key);
        if (mode.w) v.writers.add(rec.key);
      }
      // anything else: macro / enum constant / register alias -> ignore
    }
  }
}

for (const fn of funcs.values()) {
  for (const calleeKey of fn.calls) {
    const callee = funcs.get(calleeKey);
    if (callee) callee.callers.add(fn.key);
  }
}

// ---------------------------------------------------------------------------
// Mermaid emission
// ---------------------------------------------------------------------------

const sanitize = s => s.replace(/[^A-Za-z0-9_]/g, '_');
const fnId = key => 'f_' + sanitize(key);
const varId = key => 'v_' + sanitize(key);
const extId = name => 'x_' + sanitize(name);
const esc = s => String(s).replace(/"/g, "'");

const CLASSDEFS = [
  'classDef fn fill:#dbeafe,stroke:#2563eb,color:#1e3a5f',
  'classDef entry fill:#dcfce7,stroke:#16a34a,color:#14532d',
  'classDef isr fill:#fee2e2,stroke:#dc2626,color:#7f1d1d',
  'classDef gvar fill:#fef9c3,stroke:#ca8a04,color:#713f12',
  'classDef gvolatile fill:#fef3c7,stroke:#dc2626,stroke-width:2.5px,color:#713f12',
  'classDef ghost fill:#f4f4f5,stroke:#a1a1aa,color:#52525b,stroke-dasharray:5 4',
  'classDef focus stroke-width:3.5px',
  'classDef cfgstmt fill:#f8fafc,stroke:#94a3b8,color:#0f172a',
  'classDef cfgcall fill:#dbeafe,stroke:#2563eb,color:#1e3a5f',
  'classDef cfgcond fill:#fef3c7,stroke:#d97706,color:#713f12',
  'classDef cfgterm fill:#e2e8f0,stroke:#64748b,color:#334155',
  'classDef cfgjump fill:#fce7f3,stroke:#db2777,color:#831843',
];

function fnClass(fn) {
  return fn.isISR ? 'isr' : fn.isEntry ? 'entry' : 'fn';
}
function varClass(v) {
  return v.isVolatile ? 'gvolatile' : 'gvar';
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
// full HTML-label escape (labels may contain <, >, & from source text/comments)
const escLabel = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, "'");
// dim kind tag rendered to the left of the node name, like a watermark
const cap = t => `<span class='cap'>${t}</span>`;

function fnNodeLine(fn, { ghost = false, focus = false, withFile = false } = {}) {
  const kind = fn.isISR ? 'ISR' : fn.isEntry ? 'main' : 'func';
  let label = `${cap(kind)}<b>${esc(fn.name)}</b>`;
  if (withFile || ghost) label += `<br><small>${esc(fn.file)}</small>`;
  if (fn.desc && !ghost) label += `<br><small><i>${escLabel(truncate(fn.desc, 46))}</i></small>`;
  const cls = ghost ? 'ghost' : fnClass(fn);
  return `${fnId(fn.key)}["${label}"]:::${cls}${focus ? `\nclass ${fnId(fn.key)} focus` : ''}`;
}

function varNodeLine(v, { ghost = false, withFile = false, withType = false } = {}) {
  const kind = v.isExternal ? 'ext var' : v.isVolatile ? 'volatile' : 'var';
  const sub = [];
  if (withType && v.typeText) sub.push(esc(v.typeText));
  if (v.isStatic) sub.push('static');
  if ((withFile || ghost) && v.file) sub.push(esc(v.file));
  let label = `${cap(kind)}<b>${esc(v.name)}</b>`;
  if (sub.length) label += `<br><small>${sub.join(' · ')}</small>`;
  const cls = ghost || v.isExternal ? 'ghost' : varClass(v);
  return `${varId(v.key)}[("${label}")]:::${cls}`;
}

function extNodeLine(name) {
  return `${extId(name)}["${cap('ext')}<b>${esc(name)}</b>"]:::ghost`;
}

function accessEdges(fnKey, varKey, mode) {
  const f = fnId(fnKey), v = varId(varKey);
  if (mode === 'w') return [`${f} --> ${v}`];
  if (mode === 'rw') return [`${f} <--> ${v}`];
  return [`${v} --> ${f}`];
}

const callEdge = (fromKey, toKey) => `${fnId(fromKey)} -.-> ${fnId(toKey)}`;
const extCallEdge = (fromKey, name) => `${fnId(fromKey)} -.-> ${extId(name)}`;

function mermaidFlow(lines, direction = 'LR') {
  return ['flowchart ' + direction, ...CLASSDEFS.map(l => '  ' + l), ...lines.map(l => '  ' + l)].join('\n');
}

// Overview: which vars are interesting enough to show at whole-program level
function overviewVars() {
  return [...varDefs.values()].filter(v =>
    v.isVolatile || (v.readers.size + v.writers.size) >= 2 || new Set([...v.readers, ...v.writers]).size >= 2,
  );
}

function buildOverviewDiagram(rel) {
  const vars = overviewVars();
  const nodeCount = funcs.size + vars.length;
  if (nodeCount > 130) return buildAggregateDiagram(rel);

  const lines = [];
  const shownVars = new Set(vars.map(v => v.key));
  const multiFile = fileRecords.length > 1;

  for (const f of fileRecords) {
    const fnsHere = [...funcs.values()].filter(fn => fn.file === f.basename);
    const varsHere = vars.filter(v => v.file === f.basename);
    if (fnsHere.length === 0 && varsHere.length === 0) continue;
    if (multiFile) lines.push(`subgraph sg_${sanitize(f.basename)}["${esc(f.basename)}"]`);
    for (const fn of fnsHere) lines.push((multiFile ? '  ' : '') + fnNodeLine(fn));
    for (const v of varsHere) lines.push((multiFile ? '  ' : '') + varNodeLine(v));
    if (multiFile) lines.push('end');
  }
  for (const v of vars.filter(v => v.isExternal)) lines.push(varNodeLine(v));

  for (const fn of funcs.values()) {
    for (const calleeKey of fn.calls) lines.push(callEdge(fn.key, calleeKey));
    for (const [varKey, mode] of fn.access) {
      if (shownVars.has(varKey)) lines.push(...accessEdges(fn.key, varKey, mode));
    }
  }
  for (const fn of funcs.values()) {
    lines.push(`click ${fnId(fn.key)} "${rel}functions/${pageName(fn.key)}.html"`);
  }
  return mermaidFlow(lines, 'LR');
}

function buildAggregateDiagram(rel) {
  // Too many nodes: collapse to file level
  const lines = [];
  const fileOf = new Map();
  for (const fn of funcs.values()) fileOf.set(fn.key, fn.file);
  const callAgg = new Map(); // "a|b" -> count
  const varAgg = new Map();
  for (const fn of funcs.values()) {
    for (const calleeKey of fn.calls) {
      const a = fn.file, b = fileOf.get(calleeKey);
      if (!b || a === b) continue;
      const k = `${a}|${b}`;
      callAgg.set(k, (callAgg.get(k) || 0) + 1);
    }
    for (const varKey of fn.access.keys()) {
      const v = varDefs.get(varKey);
      if (!v || !v.file || v.file === fn.file) continue;
      const k = [fn.file, v.file].sort().join('|');
      varAgg.set(k, (varAgg.get(k) || 0) + 1);
    }
  }
  for (const f of fileRecords) {
    if (f.funcs.length === 0 && f.vars.defs.length === 0) continue;
    lines.push(`file_${sanitize(f.basename)}["${cap('file')}<b>${esc(f.basename)}</b><br><small>функций: ${f.funcs.length} · глобалов: ${f.vars.defs.length}</small>"]:::fn`);
    lines.push(`click file_${sanitize(f.basename)} "${rel}files/${sanitize(f.basename)}.html"`);
  }
  for (const [k, n] of callAgg) {
    const [a, b] = k.split('|');
    lines.push(`file_${sanitize(a)} -."вызовов: ${n}".-> file_${sanitize(b)}`);
  }
  for (const [k, n] of varAgg) {
    const [a, b] = k.split('|');
    lines.push(`file_${sanitize(a)} ---|"общих переменных: ${n}"| file_${sanitize(b)}`);
  }
  return mermaidFlow(lines, 'LR');
}

function buildIncludeDiagram() {
  const basenameSet = new Set(fileRecords.map(f => f.basename));
  const lines = [];
  const seen = new Set();
  for (const f of fileRecords) {
    lines.push(`file_${sanitize(f.basename)}["${cap('file')}<b>${esc(f.basename)}</b>"]:::fn`);
  }
  for (const f of fileRecords) {
    for (const inc of f.includes) {
      if (!basenameSet.has(inc.raw)) continue;
      const edge = `file_${sanitize(f.basename)} --> file_${sanitize(inc.raw)}`;
      if (!seen.has(edge)) { seen.add(edge); lines.push(edge); }
    }
  }
  return mermaidFlow(lines, 'LR');
}

function buildFileDiagram(f, rel) {
  const lines = [];
  const fnsHere = [...funcs.values()].filter(fn => fn.file === f.basename);
  const fnKeysHere = new Set(fnsHere.map(fn => fn.key));
  const varsHere = [...varDefs.values()].filter(v => v.file === f.basename);
  const varKeysHere = new Set(varsHere.map(v => v.key));

  lines.push(`subgraph sg_this["${esc(f.basename)}"]`);
  for (const fn of fnsHere) lines.push('  ' + fnNodeLine(fn));
  for (const v of varsHere) lines.push('  ' + varNodeLine(v, { withType: true }));
  lines.push('end');

  // ghosts: everything one step outside this file
  const ghostFns = new Map();
  const ghostVars = new Map();
  const extCalls = new Set();
  for (const fn of fnsHere) {
    for (const calleeKey of fn.calls) {
      if (!fnKeysHere.has(calleeKey) && funcs.has(calleeKey)) ghostFns.set(calleeKey, funcs.get(calleeKey));
    }
    for (const c of fn.callers) {
      if (!fnKeysHere.has(c) && funcs.has(c)) ghostFns.set(c, funcs.get(c));
    }
    for (const ec of fn.extCalls) extCalls.add(ec);
    for (const varKey of fn.access.keys()) {
      if (!varKeysHere.has(varKey)) ghostVars.set(varKey, varDefs.get(varKey));
    }
  }
  for (const v of varsHere) {
    for (const u of [...v.readers, ...v.writers]) {
      if (!fnKeysHere.has(u) && funcs.has(u)) ghostFns.set(u, funcs.get(u));
    }
  }
  for (const g of ghostFns.values()) lines.push(fnNodeLine(g, { ghost: true, withFile: true }));
  for (const g of ghostVars.values()) lines.push(varNodeLine(g, { ghost: true, withFile: true }));
  for (const ec of extCalls) lines.push(extNodeLine(ec));

  const shownFns = new Set([...fnKeysHere, ...ghostFns.keys()]);
  const shownVars = new Set([...varKeysHere, ...ghostVars.keys()]);
  const edgeSeen = new Set();
  const pushEdge = e => { if (!edgeSeen.has(e)) { edgeSeen.add(e); lines.push(e); } };

  for (const fnKey of shownFns) {
    const fn = funcs.get(fnKey);
    for (const calleeKey of fn.calls) {
      if (shownFns.has(calleeKey) && (fnKeysHere.has(fnKey) || fnKeysHere.has(calleeKey))) {
        pushEdge(callEdge(fnKey, calleeKey));
      }
    }
    if (fnKeysHere.has(fnKey)) {
      for (const ec of fn.extCalls) pushEdge(extCallEdge(fnKey, ec));
    }
    for (const [varKey, mode] of fn.access) {
      if (shownVars.has(varKey) && (fnKeysHere.has(fnKey) || varKeysHere.has(varKey))) {
        accessEdges(fnKey, varKey, mode).forEach(pushEdge);
      }
    }
  }

  for (const fnKey of shownFns) {
    lines.push(`click ${fnId(fnKey)} "${rel}functions/${pageName(fnKey)}.html"`);
  }
  for (const g of ghostVars.values()) {
    if (g.file) lines.push(`click ${varId(g.key)} "${rel}files/${sanitize(g.file)}.html"`);
  }
  return mermaidFlow(lines, 'LR');
}

// Flowchart of the function's own control flow (branches, loops, calls in order)
function buildCfgDiagram(fn, rel) {
  if (!fn.cfg) return null;
  const lines = [];
  for (const n of fn.cfg.nodes) {
    const label = n.label.split('\n').map(escLabel).join('<br>');
    switch (n.kind) {
      case 'term': lines.push(`${n.id}(["${label}"]):::cfgterm`); break;
      case 'ret': lines.push(`${n.id}(["${label}"]):::cfgterm`); break;
      case 'cond':
      case 'loop': lines.push(`${n.id}{"${label}"}:::cfgcond`); break;
      case 'call': lines.push(`${n.id}["${label}"]:::cfgcall`); break;
      case 'jump': lines.push(`${n.id}(["${label}"]):::cfgjump`); break;
      default: lines.push(`${n.id}["${label}"]:::cfgstmt`);
    }
    // clickable: jump to the first call target defined in this codebase
    for (const cname of n.calls || []) {
      const cands = functionsByName.get(cname);
      if (cands && cands.length) {
        const target = cands.find(c => c.basename === fn.file) || cands[0];
        lines.push(`click ${n.id} "${rel}functions/${pageName(funcKey(cname, target.basename))}.html"`);
        break;
      }
    }
  }
  for (const e of fn.cfg.edges) {
    lines.push(e.label ? `${e.from} -->|"${escLabel(e.label)}"| ${e.to}` : `${e.from} --> ${e.to}`);
  }
  return mermaidFlow(lines, 'TB');
}

// Level 0: entry points (main + ISRs) and the globals they exchange data
// through — directly (solid) or somewhere inside their call trees (dashed)
function buildLevel0Diagram(rel) {
  const entries = [...funcs.values()].filter(f => f.isEntry || f.isISR);
  if (entries.length === 0) return null;

  const info = new Map(); // entryKey -> Map(varKey -> {r, w, direct})
  for (const e of entries) {
    const acc = new Map();
    const seen = new Set([e.key]);
    const queue = [e.key];
    while (queue.length) {
      const k = queue.shift();
      const f = funcs.get(k);
      if (!f) continue;
      const direct = k === e.key;
      for (const [vk, m] of f.access) {
        const cur = acc.get(vk) || { r: false, w: false, direct: false };
        if (m.includes('r')) cur.r = true;
        if (m.includes('w')) cur.w = true;
        if (direct) cur.direct = true;
        acc.set(vk, cur);
      }
      for (const c of f.calls) if (!seen.has(c)) { seen.add(c); queue.push(c); }
    }
    info.set(e.key, acc);
  }

  // show vars that connect >=2 entries, plus volatile ones (ISR channels)
  const touchCount = new Map();
  for (const acc of info.values()) {
    for (const vk of acc.keys()) touchCount.set(vk, (touchCount.get(vk) || 0) + 1);
  }
  const show = new Set();
  for (const [vk, n] of touchCount) {
    const v = varDefs.get(vk);
    if (v && (n >= 2 || v.isVolatile)) show.add(vk);
  }

  const lines = [];
  for (const e of entries) lines.push(fnNodeLine(e));
  for (const vk of show) lines.push(varNodeLine(varDefs.get(vk), { withType: true, withFile: true }));

  let edgeIdx = 0;
  const dashedIdx = [];
  for (const e of entries) {
    for (const [vk, a] of info.get(e.key)) {
      if (!show.has(vk)) continue;
      const mode = a.r && a.w ? 'rw' : a.w ? 'w' : 'r';
      for (const line of accessEdges(e.key, vk, mode)) {
        lines.push(line);
        if (!a.direct) dashedIdx.push(edgeIdx);
        edgeIdx++;
      }
    }
  }
  if (dashedIdx.length) lines.push(`linkStyle ${dashedIdx.join(',')} stroke-dasharray:5,opacity:0.55`);
  for (const e of entries) lines.push(`click ${fnId(e.key)} "${rel}functions/${pageName(e.key)}.html"`);
  return mermaidFlow(lines, 'LR');
}

function buildFunctionDiagram(fn, rel) {
  const lines = [];
  lines.push(fnNodeLine(fn, { focus: true }));
  const shown = new Set([fn.key]);

  for (const c of fn.callers) {
    const caller = funcs.get(c);
    if (!caller || shown.has(c)) continue;
    shown.add(c);
    lines.push(fnNodeLine(caller, { withFile: caller.file !== fn.file }));
    lines.push(callEdge(c, fn.key));
  }
  for (const calleeKey of fn.calls) {
    const callee = funcs.get(calleeKey);
    if (!callee) continue;
    if (!shown.has(calleeKey)) {
      shown.add(calleeKey);
      lines.push(fnNodeLine(callee, { withFile: callee.file !== fn.file }));
    }
    lines.push(callEdge(fn.key, calleeKey));
  }
  for (const ec of fn.extCalls) {
    lines.push(extNodeLine(ec));
    lines.push(extCallEdge(fn.key, ec));
  }
  for (const [varKey, mode] of fn.access) {
    const v = varDefs.get(varKey);
    if (!v) continue;
    lines.push(varNodeLine(v, { withFile: v.file !== fn.file, withType: true }));
    lines.push(...accessEdges(fn.key, varKey, mode));
  }
  for (const key of shown) {
    lines.push(`click ${fnId(key)} "${rel}functions/${pageName(key)}.html"`);
  }
  return mermaidFlow(lines, 'LR');
}

// ---------------------------------------------------------------------------
// HTML emission
// ---------------------------------------------------------------------------

const pageNames = new Map();
function pageName(funcKey) {
  if (!pageNames.has(funcKey)) pageNames.set(funcKey, sanitize(funcKey));
  return pageNames.get(funcKey);
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #fafafa; color: #18181b; }
  nav { background: #1e293b; color: #e2e8f0; padding: 10px 20px; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  nav a { color: #93c5fd; text-decoration: none; }
  nav a:hover { text-decoration: underline; }
  nav .title { font-weight: 600; color: #f8fafc; }
  main { max-width: 1600px; margin: 0 auto; padding: 16px 20px 60px; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2em; }
  .sig { font-family: Consolas, monospace; background: #eef2f7; padding: 6px 10px; border-radius: 6px; display: inline-block; }
  .diagram { background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; overflow: auto; position: relative; }
  .diagram .inner { transform-origin: 0 0; width: max-content; padding: 12px; }
  .zoombar { position: sticky; top: 6px; left: 6px; z-index: 5; display: inline-flex; gap: 4px; margin: 6px; }
  .zoombar button { border: 1px solid #d4d4d8; background: #fff; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; font-size: 15px; }
  .zoombar button:hover { background: #f4f4f5; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 16px; font-size: 0.85rem; color: #52525b; align-items: center; }
  .chip { display: inline-block; width: 14px; height: 14px; border-radius: 4px; vertical-align: -2px; margin-right: 5px; border: 1.5px solid; }
  table { border-collapse: collapse; margin-top: 8px; font-size: 0.9rem; }
  th, td { border: 1px solid #e4e4e7; padding: 5px 12px; text-align: left; }
  th { background: #f4f4f5; }
  td a { color: #2563eb; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .muted { color: #a1a1aa; }
  details summary { cursor: pointer; font-size: 1.1rem; font-weight: 600; margin-top: 2em; }
  .tip { position: fixed; z-index: 50; max-width: 420px; background: #1e293b; color: #f1f5f9;
    padding: 8px 12px; border-radius: 8px; font-size: 12.5px; pointer-events: none;
    display: none; line-height: 1.5; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
  .tip .k { opacity: .65; font-size: 11.5px; }
  .tip .sig { font-family: Consolas, monospace; font-size: 11.5px; color: #93c5fd; margin: 2px 0; }
  .tip .d { margin-top: 4px; }
  svg g.node, svg .edgePaths path, svg .edgeLabel, svg path.flowchart-link { transition: opacity .13s; }
  svg.fade g.node, svg.fade .edgePaths path, svg.fade .edgeLabel, svg.fade path.flowchart-link { opacity: .13; }
  svg.fade .hl { opacity: 1 !important; }
  svg .edgePaths path.hl, svg path.flowchart-link.hl { stroke-width: 3px !important; }
  svg g.node { cursor: pointer; }
  svg .cap { opacity: .42; font-size: 9px; letter-spacing: .5px; margin-right: 6px;
    text-transform: uppercase; font-weight: 400; }
  svg .label small { opacity: .62; }
`;

const LEGEND = `
<div class="legend">
  <span>функция <b>&rarr;</b> переменная = <b>запись</b></span>
  <span>переменная <b>&rarr;</b> функция = <b>чтение</b></span>
  <span><b>&harr;</b> = чтение + запись</span>
  <span><b>&#8943;&gt;</b> (пунктир) = вызов, передача управления</span>
  <span><span class="chip" style="background:#f4f4f5;border-color:#a1a1aa;border-style:dashed"></span>из другого файла / внешнее</span>
  <span class="muted">наведите курсор на элемент — подсветятся его связи и появится описание</span>
</div>`;

function htmlPage({ title, rel, body }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<nav><span class="title">code graph</span><a href="${rel}index.html">обзор</a></nav>
<main>
${body}
</main>
<script src="${rel}mermaid-elk.min.js"></script>
<script src="${rel}graph-data.js"></script>
<script src="${rel}app.js"></script>
</body>
</html>`;
}

// lazy: rendered on <details> open (hidden diagrams measure text incorrectly)
function diagramBlock(code, { lazy = false } = {}) {
  return `<div class="diagram">
<div class="zoombar">
  <button onclick="zoom(this, 1.25)">+</button>
  <button onclick="zoom(this, 0.8)">&minus;</button>
</div>
<div class="inner"><pre class="${lazy ? 'mermaid-lazy' : 'mermaid'}">${escapeHtml(code)}</pre></div>
</div>`;
}

// --- write output tree ---

const filesDir = path.join(outDir, 'files');
const funcsDir = path.join(outDir, 'functions');
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(funcsDir, { recursive: true });

// bundle mermaid + ELK layout engine so the output works offline; the bundle
// is built once with esbuild and cached in dist/
const here = path.dirname(fileURLToPath(import.meta.url));
async function ensureViewerBundle() {
  const entry = path.join(here, 'viewer-entry.mjs');
  const outfile = path.join(here, 'dist', 'mermaid-elk.min.js');
  const fresh = fs.existsSync(outfile)
    && fs.statSync(outfile).mtimeMs >= fs.statSync(entry).mtimeMs;
  if (!fresh) {
    console.log('Building mermaid+ELK browser bundle (one-time)...');
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [entry], bundle: true, format: 'iife', minify: true,
      outfile, logLevel: 'silent',
    });
  }
  return outfile;
}
fs.copyFileSync(await ensureViewerBundle(), path.join(outDir, 'mermaid-elk.min.js'));
fs.copyFileSync(path.join(here, 'viewer.js'), path.join(outDir, 'app.js'));

// graph-data.js: node info for hover tooltips on every page
{
  const nodes = {};
  const fnName = k => funcs.get(k)?.name || k;
  for (const fn of funcs.values()) {
    nodes[fnId(fn.key)] = {
      label: fn.name, kind: fn.isISR ? 'isr' : fn.isEntry ? 'entry' : 'fn',
      file: fn.file, sig: fn.signature, desc: fn.desc || undefined,
    };
    for (const ec of fn.extCalls) {
      nodes[extId(ec)] = nodes[extId(ec)] || { label: ec, kind: 'extfn' };
    }
  }
  for (const v of varDefs.values()) {
    nodes[varId(v.key)] = {
      label: v.name,
      kind: v.isExternal ? 'extvar' : v.isVolatile ? 'gvolatile' : 'gvar',
      file: v.file || undefined, type: v.typeText || undefined,
      static: v.isStatic || undefined, volatile: v.isVolatile || undefined,
      desc: v.desc || undefined,
      writers: [...v.writers].map(fnName), readers: [...v.readers].map(fnName),
    };
  }
  for (const f of fileRecords) {
    nodes[`file_${sanitize(f.basename)}`] = { label: f.basename, kind: 'file', desc: f.filePath };
  }
  fs.writeFileSync(path.join(outDir, 'graph-data.js'),
    `window.GRAPH = ${JSON.stringify({ nodes })};\n`);
}

// index.html
{
  const fileRows = fileRecords.map(f =>
    `<tr><td><a href="files/${sanitize(f.basename)}.html">${escapeHtml(f.basename)}</a></td>` +
    `<td class="muted">${escapeHtml(f.filePath)}</td><td>${f.funcs.length}</td><td>${f.vars.defs.length}</td></tr>`).join('\n');

  const funcRows = [...funcs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(fn =>
    `<tr><td><a href="functions/${pageName(fn.key)}.html">${escapeHtml(fn.name)}</a>${fn.isISR ? ' <b style="color:#dc2626">ISR</b>' : ''}</td>` +
    `<td>${escapeHtml(fn.desc || '')}</td>` +
    `<td><a href="files/${sanitize(fn.file)}.html">${escapeHtml(fn.file)}</a></td>` +
    `<td>${fn.callers.size}</td><td>${fn.calls.size + fn.extCalls.size}</td><td>${fn.access.size}</td></tr>`).join('\n');

  const varRows = [...varDefs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(v => {
    const users = keys => [...keys].map(k =>
      `<a href="functions/${pageName(k)}.html">${escapeHtml(funcs.get(k)?.name || k)}</a>`).join(', ') || '<span class="muted">—</span>';
    return `<tr><td>${escapeHtml(v.name)}${v.isVolatile ? ' <b style="color:#dc2626">volatile</b>' : ''}${v.isStatic ? ' <span class="muted">static</span>' : ''}</td>` +
      `<td class="muted">${escapeHtml(v.typeText)}</td>` +
      `<td>${escapeHtml(v.desc || '')}</td>` +
      `<td>${v.file ? `<a href="files/${sanitize(v.file)}.html">${escapeHtml(v.file)}</a>` : '<span class="muted">внешняя</span>'}</td>` +
      `<td>${users(v.writers)}</td><td>${users(v.readers)}</td></tr>`;
  }).join('\n');

  const level0 = buildLevel0Diagram('');
  const body = `
<h1>Обзор программы</h1>
<p class="muted">Источник: ${roots.map(r => escapeHtml(path.resolve(r))).join(', ')} —
файлов: ${fileRecords.length}, функций: ${funcs.size}, глобальных переменных: ${varDefs.size}</p>
${LEGEND}
${level0 ? `
<h2>Уровень 0 — точки входа и обмен через глобальные переменные</h2>
<p class="muted">main и обработчики прерываний. Сплошная связь — функция обращается к переменной сама,
пунктирная — где-то внутри её вызовов. Клик по функции — спуск на уровень ниже (связи + блок-схема алгоритма).</p>
${diagramBlock(level0)}

<details>
<summary>Полная карта — все функции и переменные</summary>
${diagramBlock(buildOverviewDiagram(''), { lazy: true })}
</details>` : diagramBlock(buildOverviewDiagram(''))}

<details>
<summary>Граф include (файлы)</summary>
${diagramBlock(buildIncludeDiagram(), { lazy: true })}
</details>

<h2>Файлы</h2>
<table><tr><th>Файл</th><th>Путь</th><th>Функций</th><th>Глобалов</th></tr>${fileRows}</table>

<h2>Функции</h2>
<table><tr><th>Функция</th><th>Описание</th><th>Файл</th><th>Вызывается</th><th>Вызывает</th><th>Глобалов</th></tr>${funcRows}</table>

<h2>Глобальные переменные</h2>
<table><tr><th>Переменная</th><th>Тип</th><th>Описание</th><th>Определена в</th><th>Пишут</th><th>Читают</th></tr>${varRows}</table>`;

  fs.writeFileSync(path.join(outDir, 'index.html'), htmlPage({ title: 'Код-граф — обзор', rel: '', body }));
}

// per-file pages
for (const f of fileRecords) {
  const fnsHere = [...funcs.values()].filter(fn => fn.file === f.basename);
  const body = `
<h1>${escapeHtml(f.basename)}</h1>
<p class="muted">${escapeHtml(f.filePath)}</p>
${LEGEND}
${diagramBlock(buildFileDiagram(f, '../'))}
<h2>Функции этого файла</h2>
${fnsHere.length ? '<ul>' + fnsHere.map(fn =>
    `<li><a href="../functions/${pageName(fn.key)}.html">${escapeHtml(fn.name)}</a> <span class="sig">${escapeHtml(fn.signature)}</span>${fn.desc ? ` — ${escapeHtml(fn.desc)}` : ''}</li>`).join('\n') + '</ul>'
    : '<p class="muted">нет</p>'}`;
  fs.writeFileSync(path.join(filesDir, `${sanitize(f.basename)}.html`),
    htmlPage({ title: f.basename, rel: '../', body }));
}

// per-function pages
for (const fn of funcs.values()) {
  const varList = [...fn.access.entries()].map(([varKey, mode]) => {
    const v = varDefs.get(varKey);
    const modeText = { r: 'читает', w: 'пишет', rw: 'читает + пишет' }[mode];
    return `<li><b>${escapeHtml(v.name)}</b> — ${modeText}${v.isVolatile ? ' <b style="color:#dc2626">volatile</b>' : ''}${v.file ? ` <span class="muted">(${escapeHtml(v.file)})</span>` : ' <span class="muted">(внешняя)</span>'}${v.desc ? ` — ${escapeHtml(v.desc)}` : ''}</li>`;
  }).join('\n');
  const cfgCode = buildCfgDiagram(fn, '../');
  const body = `
<h1>${escapeHtml(fn.name)}${fn.isISR ? ' <span style="color:#dc2626;font-size:0.8em">обработчик прерывания</span>' : ''}</h1>
<p><span class="sig">${escapeHtml(fn.signature)}</span> &nbsp; в файле <a href="../files/${sanitize(fn.file)}.html">${escapeHtml(fn.file)}</a></p>
${fn.desc ? `<p>${escapeHtml(fn.desc)}</p>` : ''}
${LEGEND}
${cfgCode ? `<h2>Алгоритм</h2>
<p class="muted">Порядок выполнения: ромбы — условия и циклы, синие блоки — вызовы (кликабельны), «да/нет» — ветви.</p>
${diagramBlock(cfgCode)}` : ''}
<h2>Связи</h2>
${diagramBlock(buildFunctionDiagram(fn, '../'))}
${varList ? `<h2>Глобальные переменные функции</h2><ul>${varList}</ul>` : ''}`;
  fs.writeFileSync(path.join(funcsDir, `${pageName(fn.key)}.html`),
    htmlPage({ title: fn.name, rel: '../', body }));
}

// ---------------------------------------------------------------------------

const accessEdgeCount = [...funcs.values()].reduce((n, f) => n + f.access.size, 0);
const callEdgeCount = [...funcs.values()].reduce((n, f) => n + f.calls.size + f.extCalls.size, 0);
console.log(`Files: ${fileRecords.length}`);
console.log(`Functions: ${funcs.size}`);
console.log(`Global variables: ${varDefs.size} (volatile: ${[...varDefs.values()].filter(v => v.isVolatile).length})`);
console.log(`Call edges: ${callEdgeCount}, variable access edges: ${accessEdgeCount}`);
console.log(`HTML written to: ${path.resolve(outDir)}`);
console.log(`Open ${path.join(path.resolve(outDir), 'index.html')} in a browser.`);

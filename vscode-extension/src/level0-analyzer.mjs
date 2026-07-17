// Extension-host analyzer for the "Уровень 0" (Level 0) diagram — entry
// points (main + ISR handlers), the peripherals they read/write (with
// per-register and per-bit detail), and the global variables exchanged
// between different entry points. This is a whole-project port of the
// level-0 pipeline from the CLI's index.mjs (extractFunctions/
// extractFileScopeVars/analyzeFunction, the two-pass model builder, the dot
// emission helpers, and aggregateEntryInfo/assembleLevel0/buildLevel0Diagram),
// adapted to run on an array of already-read files instead of walking the
// filesystem, and to web-tree-sitter/graphviz-wasm instead of native
// tree-sitter/graphviz — the same adaptation cfg-analyzer.mjs already made
// for the per-function CFG ("Алгоритм") diagram.
//
// Deliberately no `import 'vscode'` here — all vscode-aware I/O (finding
// files, reading them, showing documents) stays in extension.js, so this
// module stays headlessly testable (see test-level0-analyzer.mjs) the same
// way cfg-analyzer.mjs's analyzeAllFunctions does.
//
// Only the `neato` engine is ported (not the CLI's dot/fdp switcher or its
// raw-dot neato-parameter debug tester) — those are CLI power-user/debug
// tooling, not part of the diagram itself.

import path from 'path';
import { ensureWasmRuntime, getGraphviz, parseC } from './wasm-runtime.mjs';

export async function initAnalyzer({ wasmDir }) {
  await ensureWasmRuntime({ wasmDir });
}

// ---------------------------------------------------------------------------
// Generic tree helpers (verbatim port of index.mjs)
// ---------------------------------------------------------------------------

function walkTree(node, cb) {
  cb(node);
  for (const child of node.children) walkTree(child, cb);
}

function childrenForField(node, field) {
  const out = [];
  const cursor = node.walk();
  // web-tree-sitter's TreeCursor exposes currentFieldName/currentNode as
  // METHODS (unlike native tree-sitter's getter properties of the same
  // names, which is what index.mjs's original code was written against) —
  // reading them without calling silently returned the function reference
  // itself instead of the value, so this always returned [] and leaked
  // local declarations (e.g. `const EepromRecord *r = ...`) through as
  // unresolved peripheral-candidate dereferences instead of excluding them
  // via the `locals` set.
  if (cursor.gotoFirstChild()) {
    do {
      if (cursor.currentFieldName() === field) out.push(cursor.currentNode());
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

// web-tree-sitter (like node-tree-sitter) returns a fresh wrapper object on
// every accessor call, so two references to the same syntax node are never
// `===`; compare .id instead.
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

// Adds startLine (0-based) beyond the CLI's own extractFunctions — level 0
// needs a real source position per entry so a click can jump the editor
// there, whereas the CLI only ever linked to a pre-rendered functions/*.html
// page.
function extractFunctions(root) {
  const funcs = [];
  walkTree(root, node => {
    if (node.type === 'function_definition') {
      const declarator = node.childForFieldName('declarator');
      const name = findNameInDeclarator(declarator);
      if (name) funcs.push({ name, node, startLine: node.startPosition.row });
    }
  });
  return funcs;
}

// --- doc comments -----------------------------------------------------------
// Convention: a description belongs to a declaration only if it is *adjacent* —
// either a trailing comment on the same line, or comment line(s) directly
// above with no blank line in between.

function cleanComment(text) {
  const lines = text.split('\n').map(l =>
    l.replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '')
     .replace(/^\s*\/\/+/, '').replace(/^\s*\*+(?!\/)/, '').trim(),
  ).filter(l => l && !/^[=\-_~*#+.\s]+$/.test(l));
  return lines.join(' ').replace(/\s+/g, ' ')
    .replace(/^[@\\]fn\s+\S+\s*/i, '')
    .replace(/^[@\\]brief\s*/i, '').trim();
}

function buildCommentIndex(root, srcLines) {
  const byEndRow = new Map();
  const byStartRow = new Map();
  walkTree(root, n => {
    if (n.type !== 'comment') return;
    byStartRow.set(n.startPosition.row, n);
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
// bare identifier. `void (*cb)(void)` is a function-pointer VARIABLE.
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
const mergeMode = (prev, m) => (!prev ? m : prev === m ? prev : 'rw');

// CMSIS/HAL bit-flag macros are always SHOUTING_SNAKE_CASE — used to keep
// flag extraction from misattributing a plain lowercase value as a "flag".
const MACRO_CONST_RE = /^[A-Z_][A-Z0-9_]*$/;
function collectIdentifiers(node, out) {
  if (node.type === 'identifier') {
    if (MACRO_CONST_RE.test(node.text)) out.add(node.text);
    return;
  }
  if (node.type === 'parenthesized_expression' || node.type === 'binary_expression') {
    for (const c of node.namedChildren) collectIdentifiers(c, out);
  }
}
// merges a 'w'-direction flag's set/clear polarity into an accumulating Map
// (flagName -> 'set'|'clear'|'both') — 'set' from `|= FLAG` and the one-shot
// `field = FLAG1 | FLAG2 | ...` idiom, 'clear' from `field &= ~FLAG`. The same
// bit seen as both within the merge (a channel disabled then immediately
// re-armed in the same function) collapses to 'both' rather than picking one
// arbitrarily — periphDirDetail treats 'both' as "ends up enabled", same as a
// plain 'set'. Verbatim port of the CLI's index.mjs.
function mergeFlagPolarity(map, name, polarity) {
  const prev = map.get(name);
  map.set(name, prev && prev !== polarity ? 'both' : polarity);
}

function classifyAccess(id) {
  let n = id;
  while (n.parent) {
    const p = n.parent;
    if (p.type === 'assignment_expression') {
      if (sameNode(p.childForFieldName('left'), n)) {
        // isNamed is a METHOD in web-tree-sitter (unlike native tree-sitter's
        // getter property of the same name) — must call it, not read it.
        const opNode = p.children.find(c => !c.isNamed() && c.text.endsWith('='));
        return opNode && opNode.text !== '=' ? 'rw' : 'w';
      }
      return 'r';
    }
    if (p.type === 'update_expression') return 'rw'; // ++ / --
    if (p.type === 'pointer_expression') {
      const op = p.children[0] ? p.children[0].text : '*';
      return op === '&' ? 'rw' : 'r';
    }
    if (p.type === 'subscript_expression') {
      if (sameNode(p.childForFieldName('argument'), n)) { n = p; continue; }
      return 'r';
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

// Bare DMA controller instance (DMA1, DMA2 — never DMA1_Channel4, that's its
// own instance).
const DMA_BUS_RE = /^DMA[0-9]+$/;

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
  const armCalls = new Set();
  const derefNames = new Set();
  const derefFields = new Map(); // name -> Map(field -> 'r' | 'w' | 'rw')
  const derefFlags = new Map();  // name -> Map(field -> { r: Set(flag), w: Map(flag -> 'set'|'clear'|'both') })
  // a DMA channel's own address registers (CPAR/CMAR) resolved to *what*
  // they point at, when the right-hand side of a plain `X->CPAR = ...`
  // assignment is simple enough to tell statically. See resolveAddrExpr.
  // name -> Map(field -> { kind: 'var' | 'periph', name })
  const derefAddrRefs = new Map();
  const access = new Map();      // name -> { r, w }
  const NVIC_ARM_RE = /^(HAL_|LL_)?NVIC_EnableIRQ$/;
  if (body) {
    walkTree(body, n => {
      if (n.type === 'call_expression') {
        const fn = n.childForFieldName('function');
        if (fn && fn.type === 'identifier') {
          calls.add(fn.text);
          if (NVIC_ARM_RE.test(fn.text)) {
            const args = n.childForFieldName('arguments');
            const first = args ? args.namedChildren[0] : null;
            if (first && first.type === 'identifier') armCalls.add(first.text);
          }
        }
        return;
      }
      if (n.type !== 'identifier') return;
      const p = n.parent;
      if (p && p.type === 'call_expression' && sameNode(p.childForFieldName('function'), n)) return;
      if (p && p.type === 'field_expression' && sameNode(p.childForFieldName('field'), n)) return;
      if (p && (p.type.endsWith('_declarator')) && sameNode(p.childForFieldName('declarator'), n)) return;
      const name = n.text;
      if (locals.has(name)) return;
      const mode = classifyAccess(n);
      if (p && p.type === 'field_expression' && p.childForFieldName('operator')?.text === '->'
          && sameNode(p.childForFieldName('argument'), n)) {
        derefNames.add(name);
        const field = p.childForFieldName('field')?.text;
        if (field) {
          // `w`'s per-flag value is a Map(flagName -> 'set'|'clear'|'both'),
          // not a Set — same flag name can mean opposite things depending on
          // whether it came in via `|=` (arm) or `&= ~` (disarm); `r` stays a
          // plain Set (a bit *test* has no set/clear polarity). `polarity` is
          // only meaningful when kind === 'w'.
          function addFlagNames(kind, node, polarity) {
            const flagNames = new Set();
            collectIdentifiers(node, flagNames);
            if (!flagNames.size) return;
            let flagMap = derefFlags.get(name);
            if (!flagMap) { flagMap = new Map(); derefFlags.set(name, flagMap); }
            let perKind = flagMap.get(field);
            if (!perKind) { perKind = { r: new Set(), w: new Map() }; flagMap.set(field, perKind); }
            if (kind === 'w') {
              for (const fl of flagNames) mergeFlagPolarity(perKind.w, fl, polarity);
            } else {
              for (const fl of flagNames) perKind.r.add(fl);
            }
          }
          // `X->field |= FLAG` / `X->field &= ~FLAG` is set/clear-a-bit — a
          // read-modify-write in hardware, but nothing is semantically
          // *read* here, so field-level mode downgrades to plain 'w' for
          // this idiom (avoids a phantom read edge with no real read site).
          let fieldMode = mode;
          const parent = p.parent;
          const isSetClearIdiom = parent && parent.type === 'assignment_expression'
            && sameNode(parent.childForFieldName('left'), p)
            && (() => {
              const op = parent.children.find(c => !c.isNamed() && c.text.endsWith('='))?.text;
              const right = parent.childForFieldName('right');
              if (op === '|=' && right) return true;
              if (op === '&=' && right && right.type === 'unary_expression'
                  && right.children[0]?.text === '~') return true;
              return false;
            })();
          if (isSetClearIdiom) fieldMode = 'w';

          let fm = derefFields.get(name);
          if (!fm) { fm = new Map(); derefFields.set(name, fm); }
          fm.set(field, mergeMode(fm.get(field), fieldMode));

          if (parent && parent.type === 'binary_expression' && parent.childForFieldName('operator')?.text === '&') {
            const left = parent.childForFieldName('left'), right = parent.childForFieldName('right');
            const other = sameNode(left, p) ? right : (sameNode(right, p) ? left : null);
            if (other) addFlagNames('r', other);
          } else if (parent && parent.type === 'assignment_expression' && sameNode(parent.childForFieldName('left'), p)) {
            const op = parent.children.find(c => !c.isNamed() && c.text.endsWith('='))?.text;
            const right = parent.childForFieldName('right');
            if (op === '|=' && right) {
              addFlagNames('w', right, 'set');
            } else if (op === '&=' && right && right.type === 'unary_expression'
                && right.children[0]?.text === '~') {
              addFlagNames('w', right.childForFieldName('argument'), 'clear');
            } else if (op === '=' && right) {
              addFlagNames('w', right, 'set');
              if (field === 'CPAR' || field === 'CMAR') {
                const ref = resolveAddrExpr(right);
                if (ref) {
                  let am = derefAddrRefs.get(name);
                  if (!am) { am = new Map(); derefAddrRefs.set(name, am); }
                  am.set(field, ref);
                }
              }
            }
          }
        }
      }
      const cur = access.get(name) || { r: false, w: false };
      if (mode.includes('r')) cur.r = true;
      if (mode.includes('w')) cur.w = true;
      access.set(name, cur);
    });
  }

  const typeNode = funcNode.childForFieldName('type');
  const signature = `${typeNode ? typeNode.text + ' ' : ''}${declarator ? declarator.text : ''}`
    .replace(/\s+/g, ' ');

  // Names directly called inside this function's own top-level infinite loop
  // — tells apart "runs once at boot" setup calls from what actually recurs.
  const loopCallNames = new Set();
  const loopNode = findTopLevelInfiniteLoop(body);
  if (loopNode) {
    walkTree(loopNode, n => {
      if (n.type !== 'call_expression') return;
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'identifier') loopCallNames.add(fn.text);
    });
  }
  const hasLoop = !!loopNode;

  return { calls, armCalls, derefNames, derefFields, derefFlags, derefAddrRefs, access, signature, loopCallNames, hasLoop };
}

// Strips a DMA CPAR/CMAR assignment's right-hand side down to the expression
// that actually names the source/destination address — casts and parens
// first, then, if what's left is `&something`, unwraps that one layer too.
// What remains is classified: a `->` field access names the peripheral it's
// rooted at (the specific field doesn't matter), a bare identifier names a
// var. Anything else (e.g. a local pointer's own field, whose value was
// assigned elsewhere at runtime) resolves to null — this never tries to
// trace a local variable's own prior assignment. Verbatim port of the CLI's
// index.mjs.
function resolveAddrExpr(node) {
  let n = node;
  for (;;) {
    if (n && n.type === 'parenthesized_expression') { n = n.namedChildren[0]; continue; }
    if (n && n.type === 'cast_expression') { n = n.childForFieldName('value'); continue; }
    break;
  }
  if (!n) return null;
  if (n.type === 'pointer_expression' && n.childForFieldName('operator')?.text === '&') {
    n = n.childForFieldName('argument');
    while (n && n.type === 'parenthesized_expression') n = n.namedChildren[0];
  }
  if (!n) return null;
  if (n.type === 'field_expression' && n.childForFieldName('operator')?.text === '->') {
    const base = n.childForFieldName('argument');
    return base && base.type === 'identifier' ? { kind: 'periph', name: base.text } : null;
  }
  if (n.type === 'identifier') return { kind: 'var', name: n.text };
  return null;
}

function isInfiniteLoopCondition(node) {
  if (!node) return true;
  let n = node;
  while (n.type === 'parenthesized_expression') n = n.namedChildren[0];
  if (n.type === 'number_literal') return n.text !== '0';
  if (n.type === 'true') return true;
  if (n.type === 'identifier') return n.text === 'true' || n.text === 'TRUE';
  return false;
}
function findTopLevelInfiniteLoop(bodyNode) {
  if (!bodyNode || bodyNode.type !== 'compound_statement') return null;
  for (const child of bodyNode.namedChildren) {
    if (child.type === 'while_statement' || child.type === 'for_statement') {
      if (isInfiniteLoopCondition(child.childForFieldName('condition'))) return child;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Graphviz emission (node/edge id helpers, dot node/edge builders)
// ---------------------------------------------------------------------------

const sanitize = s => s.replace(/[^A-Za-z0-9_]/g, '_');
const fnId = key => 'f_' + sanitize(key);
const varId = key => 'v_' + sanitize(key);
const periphId = name => 'p_' + sanitize(name);

function fnClass(fn) {
  return fn.isISR ? 'isr' : fn.isEntry ? 'entry' : 'fn';
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

const dotEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dotNode(id, rows, shape, cls, extra = '') {
  return `  ${id} [id="${id}" class="${cls}" shape=${shape} label=<${rows.join('<BR/>')}>${extra}];`;
}
const dotKindRow = text => `<FONT POINT-SIZE="10">${dotEsc(text)}</FONT>`;
// ghost nodes need a dashed border restated in full, since a node's own
// style= replaces the graph-level default rather than merging with it.
const GHOST_STYLE = ' style="filled,dashed"';

// Every flag name an ISR touches anywhere in its body, read-tested only
// (`if (X->SR & FLAG)`) — answers "which interrupt source is this handler
// reacting to". Deduped and capped.
function isrFlagList(fn, cap = 6) {
  const all = new Set();
  for (const regs of fn.periphFlags.values()) {
    for (const { r } of regs.values()) {
      for (const f of r) if (!isEnableFlagName(f)) all.add(f.replace(/^DMA_/, ''));
    }
  }
  if (!all.size) return '';
  const sorted = [...all].sort();
  const shown = sorted.slice(0, cap);
  return shown.join(', ') + (sorted.length > cap ? `, +${sorted.length - cap}` : '');
}
function dotFnNode(fn, { ghost = false, withFile = false, focus = false } = {}) {
  const kind = fn.isISR ? 'ISR' : fn.isEntry ? 'main' : 'func';
  const rows = [dotKindRow(kind), `<B>${dotEsc(fn.name)}</B>`];
  if (withFile || ghost) rows.push(`<FONT POINT-SIZE="9">${dotEsc(fn.file)}</FONT>`);
  if (fn.desc && !ghost) rows.push(`<FONT POINT-SIZE="9"><I>${dotEsc(truncate(fn.desc, 46))}</I></FONT>`);
  if (fn.isISR && !ghost) {
    const flags = isrFlagList(fn);
    if (flags) rows.push(`<FONT POINT-SIZE="9">${dotEsc(flags)}</FONT>`);
  }
  const cls = ghost ? 'ghost' : fnClass(fn);
  const extra = (ghost ? GHOST_STYLE : '') + (focus ? ' penwidth=3' : '');
  return dotNode(fnId(fn.key), rows, 'box', cls, extra);
}

// a bit name shaped like "this arms/turns something on" (STM32 convention:
// trailing EN/ON, or USART's own UE) — decides whether an edge's default
// label reads its enable bit's own register-qualified name.
const ENABLE_FLAG_RE = /(?:EN|ON|UE)$/;
function isEnableFlagName(name) { return ENABLE_FLAG_RE.test(name); }
// STM32 CMSIS bit-flag macros are <family>_<register>_<bit> — only the
// leading family segment repeats info the diagram already carries elsewhere.
function shortFlagName(flagName) {
  const idx = flagName.indexOf('_');
  return idx === -1 ? flagName : flagName.slice(idx + 1);
}

function dotVarNode(v, hotCut, { tiered = false, ghost = false, withFile = false } = {}) {
  const kind = v.isExternal ? 'ext var' : v.isVolatile ? 'volatile' : 'var';
  let cls = ghost || v.isExternal ? 'ghost' : 'gvar';
  if (tiered && !ghost && !v.isExternal) {
    const tier = varTier(v, hotCut);
    if (tier === 'hot') cls = 'gvarhot'; else if (tier === 'minor') cls = 'gvarminor';
  }
  const nameColor = v.isVolatile && !ghost ? ' COLOR="#dc2626"' : '';
  const rows = [dotKindRow(kind), `<B${nameColor}>${dotEsc(v.name)}</B>`];
  const sub = [];
  if (v.typeText) sub.push(dotEsc(v.typeText));
  if (v.isStatic) sub.push('static');
  if ((withFile || ghost) && v.file) sub.push(dotEsc(v.file));
  if (sub.length) rows.push(`<FONT POINT-SIZE="9">${sub.join(' &#183; ')}</FONT>`);
  return dotNode(varId(v.key), rows, 'cylinder', cls, ghost ? GHOST_STYLE : '');
}

function periphDirDetail(fields, flags, dir, cap = 6) {
  if (!fields || !fields.size) return { detail: '', hasEnable: false, enableLabel: '' };
  const regs = [...fields.entries()].filter(([, m]) => m.includes(dir)).map(([f]) => f).sort();
  if (!regs.length) return { detail: '', hasEnable: false, enableLabel: '' };
  let hasEnable = false, enableLabel = '';
  const names = regs.map(reg => {
    const bits = flags && flags.get(reg) && flags.get(reg)[dir];
    if (bits && bits.size) {
      if (dir === 'w') {
        // bits: Map(flagName -> 'set'|'clear'|'both') — a bit only ever
        // cleared here (`&= ~FLAG`, never `|= FLAG` anywhere in the same
        // tree) gets a literal ~ prefix so it reads as "turned off", not
        // "turned on"; 'set' and 'both' render plain.
        const sorted = [...bits.keys()].sort();
        if (!hasEnable) {
          // excludes pure-'clear' bits — this label means "this edge arms
          // the peripheral", and a bit only ever cleared here does the
          // opposite.
          const enableBit = sorted.find(fl => isEnableFlagName(fl) && bits.get(fl) !== 'clear');
          if (enableBit) { hasEnable = true; enableLabel = shortFlagName(enableBit); }
        }
        return sorted.map(fl => (bits.get(fl) === 'clear' ? '~' : '') + shortFlagName(fl)).join(', ');
      }
      const sorted = [...bits].sort();
      return sorted.map(shortFlagName).join(', ');
    }
    return reg;
  });
  const shown = names.slice(0, cap);
  if (names.length > cap) shown.push(`+${names.length - cap}`);
  return { detail: shown.join('\\n'), hasEnable, enableLabel };
}
function dotPeriphNode(p) {
  const hot = p.isrTargets.size > 0 && (p.readers.size + p.writers.size) > 0;
  return dotNode(periphId(p.name), [dotKindRow('периферия'), `<B>${dotEsc(p.name)}</B>`], 'hexagon', hot ? 'periphhot' : 'periph');
}
function dotVarBundleNode(id, vars, tier) {
  let cls = 'gvar';
  if (tier === 'hot') cls = 'gvarhot'; else if (tier === 'minor') cls = 'gvarminor';
  const rows = vars.map(v => v.name).sort().map(name => `<B>${dotEsc(name)}</B>`);
  return dotNode(id, rows, 'cylinder', cls);
}

function dotEdge(from, to, { dir = 'forward', style, label, penwidth, id, color, cls } = {}) {
  const attrs = [`dir=${dir}`];
  if (id) attrs.push(`id="${dotEsc(id)}"`);
  // graphviz appends this to the SVG group's own "edge" class (same
  // mechanism dotNode already uses for its own class= — see
  // media/level0.css for the CSS this exists to target: the webview's
  // theme-aware `svg g.edge path { stroke: var(--vscode-foreground); }`
  // default would otherwise stomp the inline color= below).
  if (cls) attrs.push(`class="${dotEsc(cls)}"`);
  if (style) attrs.push(`style=${style}`);
  if (color) attrs.push(`color="${color}", fontcolor="${color}"`);
  if (label) {
    attrs.push(`label="${dotEsc(label)}"`);
    attrs.push('len=3.5');
  }
  if (penwidth) attrs.push(`penwidth=${penwidth}`);
  return `  ${from} -> ${to} [${attrs.join(', ')}];`;
}
// Every var shown at level 0 is written by one entry and read by a different
// one, so there's no single "direction" — plain undirected connector
// (solid = the entry accesses it directly, dashed = only down its call tree).
function dotAccessLink(fnKey, targetId, direct, downstream) {
  const a = fnId(fnKey);
  const [from, to] = downstream ? [a, targetId] : [targetId, a];
  return dotEdge(from, to, { dir: 'none', style: direct ? undefined : 'dashed' });
}
// 0-2 directed edges per peripheral (never dir=both) — solid=write
// (entry->periph), dashed=read (periph->entry). Default label is the enable
// bit's own register-qualified name when one was detected; the full
// register/flag breakdown rides along in `details` for injectPeriphDetailLabels
// to splice into the SVG as a hidden hover-reveal (see the CSS
// .periph-detail/.periph-default pair, ported into graph-view.css).
function dotPeriphAccessEdges(fnKey, periphName, fields, flags, idPrefix) {
  const a = fnId(fnKey), b = periphId(periphName);
  const lines = [];
  const details = [];

  const w = periphDirDetail(fields, flags, 'w');
  const r = periphDirDetail(fields, flags, 'r');

  if (w.detail) {
    // RCC is excluded from the "_EN" callout: its enable bits are clock
    // gates for *other* peripherals, not a fact about RCC itself.
    const defaultLabel = periphName === 'RCC' ? '' : (w.hasEnable ? w.enableLabel : '');
    const id = `pe_${idPrefix}_${a}_${b}_w`;
    lines.push(dotEdge(a, b, { label: defaultLabel || ' ', id }));
    details.push({ id, defaultLabel, detail: w.detail });
  }

  if (r.detail) {
    const id = `pe_${idPrefix}_${b}_${a}_r`;
    lines.push(dotEdge(b, a, { style: 'dashed', label: ' ', id }));
    details.push({ id, defaultLabel: '', detail: r.detail });
  }

  return { lines, details };
}

// A DMA channel's data source/destination — a different relationship from
// the plain register read/write edges above ("who touched this register" vs
// "where does the data physically end up") — so it gets its own color
// rather than reusing solid=write/dashed=read. Direction follows the
// transfer's real direction (source -> channel -> destination). label is the
// register the address came from (CPAR/CMAR), shown small and
// always-visible. Verbatim port of the CLI's index.mjs.
const DMA_FLOW_COLOR = '#0d9488';
function dotDmaFlowEdge(fromId, toId, label, id) {
  return dotEdge(fromId, toId, { style: 'dashed', label, id, color: DMA_FLOW_COLOR, cls: 'dma-flow' });
}

// ---------------------------------------------------------------------------
// SVG post-processing: inject hidden hover-reveal register/bit detail onto
// each peripheral edge, and bend anti-parallel (read/write) edge pairs apart
// so they don't render as one misleadingly-bidirectional line.
// ---------------------------------------------------------------------------

function pathPoints(pathD) {
  const nums = pathD && pathD.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([parseFloat(nums[i]), parseFloat(nums[i + 1])]);
  return pts;
}
function pushLabelPerp(pathD, x0, y0, dist) {
  const pts = pathPoints(pathD);
  if (!pts || pts.length < 2) return { x: x0, y: y0 };
  let best = null, bestDist = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d = Math.hypot((x1 + x2) / 2 - x0, (y1 + y2) / 2 - y0);
    if (d < bestDist) { bestDist = d; best = [x1, y1, x2, y2]; }
  }
  const [x1, y1, x2, y2] = best;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { x: x0, y: y0 };
  return { x: x0 + (-dy / len) * dist, y: y0 + (dx / len) * dist };
}
const PERIPH_LABEL_PUSH_NEAR = 8;
const PERIPH_LABEL_PUSH_PER_LINE = 6;
function injectPeriphDetailLabels(svg, details) {
  if (!details.length) return svg;
  for (const { id, detail } of details) {
    const re = new RegExp(`(<g id="${id}" class="edge">[\\s\\S]*?)(<text([^>]*)>([^<]*)<\\/text>)`);
    const m = svg.match(re);
    if (!m) continue;
    const attrs = m[3];
    const yMatch = attrs.match(/ y="([^"]+)"/);
    const xMatch = attrs.match(/ x="([^"]+)"/);
    if (!yMatch || !xMatch) continue;
    const origX = parseFloat(xMatch[1]), origY = parseFloat(yMatch[1]);
    const pathMatch = m[1].match(/<path\b[^>]*\bd="([^"]+)"/);
    const pathD = pathMatch && pathMatch[1];
    const lines = detail.split('\\n');
    const near = pushLabelPerp(pathD, origX, origY, PERIPH_LABEL_PUSH_NEAR);
    const far = pushLabelPerp(pathD, origX, origY, PERIPH_LABEL_PUSH_NEAR + PERIPH_LABEL_PUSH_PER_LINE * lines.length);
    const defaultAttrs = attrs
      .replace(/ x="[^"]+"/, ` x="${near.x.toFixed(2)}"`)
      .replace(/ y="[^"]+"/, ` y="${near.y.toFixed(2)}"`);
    const dy = 12;
    const baseY = far.y - dy * (lines.length - 1) / 2;
    const detailBaseAttrs = attrs.replace(/ x="[^"]+"/, ` x="${far.x.toFixed(2)}"`);
    const detailTexts = lines.map((line, i) => {
      const lineAttrs = detailBaseAttrs.replace(/ y="[^"]+"/, ` y="${(baseY + dy * i).toFixed(2)}"`);
      return `<text class="periph-detail"${lineAttrs}>${dotEsc(line)}</text>`;
    }).join('');
    const replacement = m[1] + `<text class="periph-default"${defaultAttrs}>${m[4]}</text>` + detailTexts;
    svg = svg.slice(0, m.index) + replacement + svg.slice(m.index + m[0].length);
  }
  return svg;
}
function bendOneEdge(pathD, body) {
  const nums = pathD.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  const x1 = parseFloat(nums[0]), y1 = parseFloat(nums[1]);
  const x2 = parseFloat(nums[nums.length - 2]), y2 = parseFloat(nums[nums.length - 1]);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const bend = Math.min(18, len * 0.16);
  const cx = (x1 + x2) / 2 + (-dy / len) * bend, cy = (y1 + y2) / 2 + (dx / len) * bend;
  const newD = `M${x1.toFixed(2)},${y1.toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
  let out = body.replace(/(<path\b[^>]*\bd=")([^"]+)(")/, (_, pre, _old, post) => pre + newD + post);

  const polyM = out.match(/<polygon\b[^>]*\bpoints="([^"]+)"[^>]*\/>/);
  if (polyM) {
    const rot = Math.atan2(y2 - cy, x2 - cx) - Math.atan2(dy, dx);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const pts = polyM[1].trim().split(/\s+/).map(p => {
      const [px, py] = p.split(',').map(Number);
      const rx = px - x2, ry = py - y2;
      return `${(x2 + rx * cos - ry * sin).toFixed(2)},${(y2 + rx * sin + ry * cos).toFixed(2)}`;
    }).join(' ');
    out = out.replace(/(<polygon\b[^>]*\bpoints=")([^"]+)(")/, (_, pre, _old, post) => pre + pts + post);
  }

  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
  const offX = cx - midX, offY = cy - midY;
  out = out.replace(/(<text\b[^>]*\bx=")([^"]+)("[^>]*\by=")([^"]+)(")/g, (_, pre1, xVal, mid, yVal, post) =>
    `${pre1}${(parseFloat(xVal) + offX).toFixed(2)}${mid}${(parseFloat(yVal) + offY).toFixed(2)}${post}`);

  return out;
}
// strips the XML prolog / DOCTYPE / leading comments graphviz-wasm emits —
// the webview injects this via innerHTML, where a leading <?xml?> parses as
// a bogus comment (same fix cfg-analyzer.mjs's cfgToSvg already applies).
function stripXmlProlog(svg) {
  const at = svg.indexOf('<svg');
  return at > 0 ? svg.slice(at) : svg;
}

function bendAntiParallelEdges(svg) {
  const groupRe = /<g id="[^"]*" class="edge">[\s\S]*?<\/g>/g;
  const found = [];
  let m;
  while ((m = groupRe.exec(svg))) {
    const body = m[0];
    const titleM = body.match(/<title>([^<]+)<\/title>/);
    const pathM = body.match(/<path\b[^>]*\bd="([^"]+)"[^>]*\/>/);
    if (!titleM || !pathM) continue;
    const parts = titleM[1].split('&#45;&gt;');
    if (parts.length !== 2) continue;
    found.push({ start: m.index, end: m.index + body.length, body, from: parts[0], to: parts[1], pathD: pathM[1] });
  }
  const pairKeys = new Set(found.map(e => `${e.from}>${e.to}`));
  let out = svg;
  for (let i = found.length - 1; i >= 0; i--) {
    const e = found[i];
    if (!pairKeys.has(`${e.to}>${e.from}`)) continue;
    const bent = bendOneEdge(e.pathD, e.body);
    if (!bent) continue;
    out = out.slice(0, e.start) + bent + out.slice(e.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-project importance of globals (varTier/sizeTier) — needs hotCut,
// computed once per buildLevel0() call from every variable in the project,
// so it's threaded through as a parameter rather than closed over module state.
// ---------------------------------------------------------------------------

function varTier(v, hotCut) {
  if (v.isExternal) return 'normal';
  if (v.score >= hotCut && v.users >= 3) return 'hot';
  if (v.users <= 1) return 'minor';
  return 'normal';
}
function sizeTier(n, allSizes) {
  const sizes = allSizes.filter(x => x >= 2).sort((a, b) => a - b);
  const cut = sizes.length
    ? Math.max(4, sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.8))])
    : Infinity;
  if (n >= cut) return 'hot';
  if (n <= 2) return 'minor';
  return 'normal';
}

// ---------------------------------------------------------------------------
// renderDotAll — only `neato` is rendered (see module header). Kept as a
// single-element loop (LEVEL0_ENGINES) rather than hardcoding the key name
// so the svgs dict keeps the same "<engine>[_novars]" shape the rest of the
// pipeline (assembleLevel0/withVariantSuffix/buildLevel0Diagram) already
// expects — those are otherwise verbatim ports and don't need to change.
// ---------------------------------------------------------------------------

const LEVEL0_ENGINES = ['neato'];

async function renderDotAll(coreNodeLines, coreEdgeLines, varNodeLines = [], varEdgeLines = [], { rankdir = 'LR' } = {}) {
  const graphviz = getGraphviz();
  const svgs = {};
  const hasVars = varNodeLines.length > 0;
  const build = (nodeLines, edgeLines, engine) => {
    const engineAttrs = engine === 'dot'
      ? `rankdir=${rankdir}, ranksep=0.6`
      : 'overlap=false, splines=true, sep="+12"';
    return ['digraph G {',
      // transparent, not white: graphviz otherwise paints an opaque
      // background polygon covering the whole canvas — reads as a stray
      // white box once the webview sits on a dark VS Code theme (same fix
      // cfg-analyzer.mjs's cfgToSvg already applies). Node fill colors are
      // still styled by CSS class (see media/level0.css), independent of this.
      `  graph [fontname="Segoe UI, Helvetica, sans-serif", nodesep=0.35, bgcolor=transparent, ${engineAttrs}];`,
      '  node [fontname="Segoe UI, Helvetica, sans-serif", style=filled, fillcolor=white];',
      '  edge [fontname="Segoe UI, Helvetica, sans-serif", fontsize=10];',
      ...nodeLines, ...edgeLines, '}'].join('\n');
  };
  for (const engine of LEVEL0_ENGINES) {
    svgs[engine] = graphviz.layout(
      build([...coreNodeLines, ...varNodeLines], [...coreEdgeLines, ...varEdgeLines], engine), 'svg', engine);
    if (hasVars) {
      svgs[engine + '_novars'] = graphviz.layout(build(coreNodeLines, coreEdgeLines, engine), 'svg', engine);
    }
  }
  return { svgs, hasVars };
}

// ---------------------------------------------------------------------------
// aggregateEntryInfo / assembleLevel0 / buildLevel0Diagram
// ---------------------------------------------------------------------------

// One entry's call-tree aggregation (which vars/peripherals/arms it reaches,
// and whether each is touched *directly* by the entry itself vs somewhere
// down the tree), seeded by seedFn(entry).
function aggregateEntryInfo(funcs, entries, seedFn, includeOwnDirect = () => true) {
  const varInfo = new Map(), periphInfo = new Map(), periphFieldInfo = new Map();
  const periphFlagInfo = new Map(), periphAddrRefInfo = new Map(), armInfo = new Map();
  for (const e of entries) {
    const vAcc = new Map(), pAcc = new Map(), aAcc = new Set(), pFields = new Map(), pFlags = new Map();
    const pAddrRefs = new Map();
    const seen = new Set([e.key]);
    function absorb(k, direct) {
      const f = funcs.get(k);
      if (!f) return;
      for (const [vk, m] of f.access) {
        const cur = vAcc.get(vk) || { r: false, w: false, direct: false };
        if (m.includes('r')) cur.r = true;
        if (m.includes('w')) cur.w = true;
        if (direct) cur.direct = true;
        vAcc.set(vk, cur);
      }
      for (const [pk, m] of f.periphAccess) {
        const cur = pAcc.get(pk) || { r: false, w: false, direct: false };
        if (m.includes('r')) cur.r = true;
        if (m.includes('w')) cur.w = true;
        if (direct) cur.direct = true;
        pAcc.set(pk, cur);
      }
      for (const [pk, fields] of f.periphFields) {
        let rf = pFields.get(pk);
        if (!rf) { rf = new Map(); pFields.set(pk, rf); }
        for (const [reg, m] of fields) rf.set(reg, mergeMode(rf.get(reg), m));
      }
      for (const [pk, fields] of f.periphFlags) {
        let rf = pFlags.get(pk);
        if (!rf) { rf = new Map(); pFlags.set(pk, rf); }
        for (const [reg, { r, w }] of fields) {
          if (!rf.has(reg)) rf.set(reg, { r: new Set(), w: new Map() });
          const cur = rf.get(reg);
          for (const fl of r) cur.r.add(fl);
          for (const [fl, pol] of w) mergeFlagPolarity(cur.w, fl, pol);
        }
      }
      for (const [pk, refs] of f.periphAddrRefs) {
        let ra = pAddrRefs.get(pk);
        if (!ra) { ra = new Map(); pAddrRefs.set(pk, ra); }
        // last absorbed write wins on a conflict — not modeled as multiple
        // candidates, just picks one deterministically.
        for (const [field, ref] of refs) ra.set(field, ref);
      }
      for (const pk of f.arms) aAcc.add(pk);
    }
    if (includeOwnDirect(e)) absorb(e.key, true);
    const queue = [];
    for (const seed of seedFn(e)) if (!seen.has(seed)) { seen.add(seed); queue.push(seed); }
    while (queue.length) {
      const k = queue.shift();
      absorb(k, false);
      const f = funcs.get(k);
      if (f) for (const c of f.calls) if (!seen.has(c)) { seen.add(c); queue.push(c); }
    }
    varInfo.set(e.key, vAcc);
    periphInfo.set(e.key, pAcc);
    periphFieldInfo.set(e.key, pFields);
    periphFlagInfo.set(e.key, pFlags);
    periphAddrRefInfo.set(e.key, pAddrRefs);
    armInfo.set(e.key, aAcc);
  }
  return { varInfo, periphInfo, periphFieldInfo, periphFlagInfo, periphAddrRefInfo, armInfo };
}

const LEVEL0_MAX_UNITS = 50;
const LEVEL0_MAX_PERIPHS = 40;

// Builds one Level 0 variant's node/edge lines from an aggregateEntryInfo()
// result — idPrefix keeps this variant's var-bundle ids (bnd_0, bnd_1, ...)
// from colliding with another variant's once both sets of extraNodes get
// merged into one payload.
function assembleLevel0(varDefs, peripherals, hotCut, entries, info, idPrefix, includeDma = false) {
  const { varInfo, periphInfo, periphFieldInfo, periphFlagInfo, periphAddrRefInfo } = info;

  const allVarKeys = new Set();
  for (const acc of varInfo.values()) for (const vk of acc.keys()) allVarKeys.add(vk);
  const showVars = [...allVarKeys].filter(vk => {
    if (!varDefs.has(vk)) return false;
    const accs = entries.filter(e => varInfo.get(e.key).has(vk));
    return accs.some(e1 => varInfo.get(e1.key).get(vk).w &&
      accs.some(e2 => e2 !== e1 && varInfo.get(e2.key).get(vk).r));
  });

  const bundleMap = new Map();
  for (const vk of showVars) {
    const involved = entries.filter(e => varInfo.get(e.key).has(vk)).map(e => e.key).sort();
    const sig = involved.join(',');
    if (!bundleMap.has(sig)) bundleMap.set(sig, { involved, vars: [] });
    bundleMap.get(sig).vars.push(vk);
  }
  let bundles = [...bundleMap.values()];

  let varCapNote = '';
  if (bundles.length > LEVEL0_MAX_UNITS) {
    const total = bundles.length;
    const bundleScore = b => b.vars.reduce((s, vk) => s + (varDefs.get(vk)?.score || 0), 0);
    bundles.sort((a, b) => bundleScore(b) - bundleScore(a));
    bundles = bundles.slice(0, LEVEL0_MAX_UNITS);
    varCapNote = `показаны ${LEVEL0_MAX_UNITS} самых используемых каналов данных из ${total}`;
  }

  // A peripheral earns a node purely by real register access — arming it
  // (NVIC_EnableIRQ) alone is not enough (arming has its own home: the
  // synthetic NVIC node, fed the same as any real peripheral).
  const usedPeriphs = new Set();
  for (const e of entries) {
    for (const pk of periphInfo.get(e.key).keys()) usedPeriphs.add(pk);
  }

  let periphList = [...usedPeriphs].map(n => peripherals.get(n)).filter(Boolean);
  let periphCapNote = '';
  if (periphList.length > LEVEL0_MAX_PERIPHS) {
    const total = periphList.length;
    const periphScore = p => p.readers.size + p.writers.size + p.armers.size + p.isrTargets.size;
    periphList.sort((a, b) => periphScore(b) - periphScore(a));
    periphList = periphList.slice(0, LEVEL0_MAX_PERIPHS);
    periphCapNote = `показаны ${LEVEL0_MAX_PERIPHS} самых задействованных узлов периферии из ${total}`;
  }

  const nodeLines = [];
  const edgeLines = [];
  const varNodeLines = [];
  const varEdgeLines = [];
  // an entry only earns a node once something actually connects to it in
  // *this* variant.
  const connectedEntries = new Set();
  for (const p of periphList) nodeLines.push(dotPeriphNode(p));

  function bundleDownstream(b) {
    let w = 0, r = 0;
    for (const ek of b.involved) {
      if (b.vars.some(vk => varInfo.get(ek).get(vk)?.w)) w++;
      if (b.vars.some(vk => varInfo.get(ek).get(vk)?.r)) r++;
    }
    return w >= r;
  }

  const singletons = bundles.filter(b => b.vars.length === 1);
  const multi = bundles.filter(b => b.vars.length >= 2);
  for (const b of singletons) {
    varNodeLines.push(dotVarNode(varDefs.get(b.vars[0]), hotCut, { tiered: true }));
  }
  for (const b of singletons) {
    const vk = b.vars[0];
    const downstream = bundleDownstream(b);
    for (const ek of b.involved) {
      const a = varInfo.get(ek).get(vk);
      varEdgeLines.push(dotAccessLink(ek, varId(vk), a.direct, downstream));
      connectedEntries.add(ek);
    }
  }

  const edgeDetails = [];
  for (const e of entries) {
    const pAcc = periphInfo.get(e.key);
    const pFields = periphFieldInfo.get(e.key);
    const pFlags = periphFlagInfo.get(e.key);
    for (const p of periphList) {
      const a = pAcc.get(p.name);
      if (!a) continue;
      const { lines, details } = dotPeriphAccessEdges(
        e.key, p.name, pFields.get(p.name), pFlags.get(p.name), idPrefix);
      if (lines.length) connectedEntries.add(e.key);
      edgeLines.push(...lines);
      edgeDetails.push(...details);
    }
  }

  // DMA channel data-flow edges — see resolveAddrExpr/periphAddrRefInfo: which
  // peripheral/global buffer a channel's CPAR/CMAR resolves to, and (via the
  // CCR DIR bit) which direction the transfer runs. This is a hardware-wiring
  // fact about the channel itself, not something scoped to whichever entry
  // happens to reach the assignment that set it up — so it's drawn once per
  // channel, merged across every entry in this variant, rather than once per
  // entry the way periph access edges above are. Verbatim port of the CLI's
  // index.mjs.
  let hasDma = false;
  if (includeDma) {
    const singletonVarKeys = new Set(singletons.map(b => b.vars[0]));
    const forcedDmaIds = new Set();
    // resolves a CPAR/CMAR ref to a node id, forcing a node onto the diagram
    // if the target isn't on it already — always the entity's own regular id
    // (periphId/varId), never a synthetic one, since buildLevel0's nodeInfo
    // already carries full hover metadata for *every* peripheral/var in the
    // whole project, not just ones some diagram happens to draw a node for —
    // reusing the real id gets that metadata for free. Safe to reuse
    // unconditionally: a peripheral only ever has the one id anywhere on the
    // page; a var's id is only ever a real node when it earned its own
    // singleton via the normal cross-entry filter (showVars) — a var folded
    // into a multi-var bundle has no node of its own under its own id (only
    // the bundle's bnd_N id exists), so there's nothing to collide with.
    function resolveDmaRef(ref) {
      if (!ref) return null;
      if (ref.kind === 'periph') {
        const target = peripherals.get(ref.name);
        if (!target) return null;
        const id = periphId(ref.name);
        if (!periphList.includes(target) && !forcedDmaIds.has(id)) {
          nodeLines.push(dotPeriphNode(target));
          forcedDmaIds.add(id);
        }
        return id;
      }
      const v = varDefs.get(ref.key);
      if (!v) return null;
      const id = varId(ref.key);
      if (!singletonVarKeys.has(ref.key) && !forcedDmaIds.has(id)) {
        varNodeLines.push(dotVarNode(v, hotCut, { tiered: true }));
        forcedDmaIds.add(id);
      }
      return id;
    }
    for (const p of periphList) {
      const refs = new Map();
      let ccrDir; // undefined | 'set' | 'clear' | 'both'
      for (const e of entries) {
        const eRefs = periphAddrRefInfo.get(e.key).get(p.name);
        if (eRefs) for (const [field, ref] of eRefs) refs.set(field, ref);
        const dirFlags = periphFlagInfo.get(e.key).get(p.name)?.get('CCR')?.w;
        if (dirFlags) {
          for (const [fl, pol] of dirFlags) {
            if (!/_DIR$/.test(fl)) continue;
            ccrDir = ccrDir && ccrDir !== pol ? 'both' : pol;
          }
        }
      }
      const cparRef = refs.get('CPAR'), cmarRef = refs.get('CMAR');
      if (!cparRef && !cmarRef) continue;
      // DMA_CCR_DIR set (or set-and-cleared, i.e. genuinely armed at some
      // point) means memory -> peripheral (TX); unset/absent is the STM32
      // default, peripheral -> memory (RX).
      const isTx = ccrDir === 'set' || ccrDir === 'both';
      const periphSideId = resolveDmaRef(cparRef);
      const memSideId = resolveDmaRef(cmarRef);
      if (!periphSideId && !memSideId) continue;
      const channelId = periphId(p.name);
      // any edge touching a var-kind endpoint has to land in varEdgeLines,
      // not edgeLines — a variant with "переменные" unchecked drops
      // varNodeLines (and the singleton var nodes the normal filter already
      // added) but keeps edgeLines verbatim, so an edge into a var node left
      // in edgeLines would dangle in that render.
      const push = (ref, line) => (ref.kind === 'var' ? varEdgeLines : edgeLines).push(line);
      hasDma = true;
      if (isTx) {
        if (memSideId) push(cmarRef, dotDmaFlowEdge(memSideId, channelId, 'CMAR', `dma_${idPrefix}_${channelId}_cmar`));
        if (periphSideId) push(cparRef, dotDmaFlowEdge(channelId, periphSideId, 'CPAR', `dma_${idPrefix}_${channelId}_cpar`));
      } else {
        if (periphSideId) push(cparRef, dotDmaFlowEdge(periphSideId, channelId, 'CPAR', `dma_${idPrefix}_${channelId}_cpar`));
        if (memSideId) push(cmarRef, dotDmaFlowEdge(channelId, memSideId, 'CMAR', `dma_${idPrefix}_${channelId}_cmar`));
      }
    }
  }

  let gi = 0;
  const extraNodes = {};
  const multiSizes = multi.map(b => b.vars.length);
  for (const b of multi) {
    const id = `bnd_${idPrefix}${gi++}`;
    const downstream = bundleDownstream(b);
    const vars = b.vars.map(vk => varDefs.get(vk));
    varNodeLines.push(dotVarBundleNode(id, vars, sizeTier(vars.length, multiSizes)));
    for (const ek of b.involved) {
      const allDirect = b.vars.every(vk => (varInfo.get(ek).get(vk) || {}).direct);
      varEdgeLines.push(dotAccessLink(ek, id, allDirect, downstream));
      connectedEntries.add(ek);
    }
    extraNodes[id] = {
      label: `${vars.length} перем.`, kind: 'gvar',
      desc: vars.map(v => v.name).sort().join(', '),
    };
  }

  const entryLines = entries.filter(e => connectedEntries.has(e.key)).map(e => dotFnNode(e));
  nodeLines.unshift(...entryLines);

  const note = [varCapNote, periphCapNote].filter(Boolean).join('; ');
  return { nodeLines, edgeLines, varNodeLines, varEdgeLines, extraNodes, note, edgeDetails, hasDma };
}

// inserts a variant suffix (e.g. "_cyclic") before the trailing "_novars"
// segment, matching renderDotAll's own key shape ("<engine>"/"<engine>_novars").
function withVariantSuffix(key, suffix) {
  return key.endsWith('_novars') ? key.slice(0, -'_novars'.length) + suffix + '_novars' : key + suffix;
}

// Every peripheral name / var key touched *anywhere* across all entries in
// an aggregateEntryInfo() result, compared at whole-diagram identity (not
// per-entry) so the cyclic/setup overlap math can find e.g. a peripheral
// cyclically touched by one ISR and only-at-setup touched by main.
function usedNames(peripherals, info, entries, includeIsrTriggers = false, excludeOwnDirect = false) {
  const periphs = new Set(), vars = new Set();
  for (const e of entries) {
    for (const [pk, a] of info.periphInfo.get(e.key)) {
      if (excludeOwnDirect && a.direct) continue;
      periphs.add(pk);
    }
    for (const pk of info.armInfo.get(e.key)) periphs.add(pk);
    for (const [vk, a] of info.varInfo.get(e.key)) {
      if (excludeOwnDirect && a.direct) continue;
      vars.add(vk);
    }
  }
  // firing an interrupt at all is itself cyclic/runtime behavior.
  if (includeIsrTriggers) {
    for (const p of peripherals.values()) if (p.isrTargets.size) periphs.add(p.name);
  }
  return { periphs, vars };
}

// Rebuilds an aggregateEntryInfo()-shaped structure containing only the
// given peripheral names / var keys, merging entryA's and entryB's per-key
// values wherever both happen to touch the same one.
function mergeFilteredInfo(entries, allowedPeriphs, allowedVars, ...infos) {
  const varInfo = new Map(), periphInfo = new Map(), periphFieldInfo = new Map();
  const periphFlagInfo = new Map(), periphAddrRefInfo = new Map(), armInfo = new Map();
  for (const e of entries) {
    const vAcc = new Map(), pAcc = new Map(), aAcc = new Set(), pFields = new Map(), pFlags = new Map();
    const pAddrRefs = new Map();
    for (const info of infos) {
      for (const [vk, a] of info.varInfo.get(e.key)) {
        if (!allowedVars.has(vk)) continue;
        const cur = vAcc.get(vk) || { r: false, w: false, direct: false };
        cur.r ||= a.r; cur.w ||= a.w; cur.direct ||= a.direct;
        vAcc.set(vk, cur);
      }
      for (const [pk, a] of info.periphInfo.get(e.key)) {
        if (!allowedPeriphs.has(pk)) continue;
        const cur = pAcc.get(pk) || { r: false, w: false, direct: false };
        cur.r ||= a.r; cur.w ||= a.w; cur.direct ||= a.direct;
        pAcc.set(pk, cur);
      }
      for (const [pk, fields] of info.periphFieldInfo.get(e.key)) {
        if (!allowedPeriphs.has(pk)) continue;
        let rf = pFields.get(pk);
        if (!rf) { rf = new Map(); pFields.set(pk, rf); }
        for (const [reg, m] of fields) rf.set(reg, mergeMode(rf.get(reg), m));
      }
      for (const [pk, fields] of info.periphFlagInfo.get(e.key)) {
        if (!allowedPeriphs.has(pk)) continue;
        let rf = pFlags.get(pk);
        if (!rf) { rf = new Map(); pFlags.set(pk, rf); }
        for (const [reg, { r, w }] of fields) {
          if (!rf.has(reg)) rf.set(reg, { r: new Set(), w: new Map() });
          const cur = rf.get(reg);
          for (const fl of r) cur.r.add(fl);
          for (const [fl, pol] of w) mergeFlagPolarity(cur.w, fl, pol);
        }
      }
      for (const [pk, refs] of info.periphAddrRefInfo.get(e.key)) {
        if (!allowedPeriphs.has(pk)) continue;
        let ra = pAddrRefs.get(pk);
        if (!ra) { ra = new Map(); pAddrRefs.set(pk, ra); }
        for (const [field, ref] of refs) ra.set(field, ref);
      }
      for (const pk of info.armInfo.get(e.key)) if (allowedPeriphs.has(pk)) aAcc.add(pk);
    }
    varInfo.set(e.key, vAcc);
    periphInfo.set(e.key, pAcc);
    periphFieldInfo.set(e.key, pFields);
    periphFlagInfo.set(e.key, pFlags);
    periphAddrRefInfo.set(e.key, pAddrRefs);
    armInfo.set(e.key, aAcc);
  }
  // a peripheral allowed in purely for triggering an ISR has no
  // periphInfo/armInfo entry anywhere above — a no-access placeholder on the
  // first entry is enough for assembleLevel0 to still give it a node.
  if (entries.length) {
    const anchor = periphInfo.get(entries[0].key);
    for (const name of allowedPeriphs) {
      const hasAny = [...periphInfo.values()].some(m => m.has(name)) || [...armInfo.values()].some(s => s.has(name));
      if (!hasAny) anchor.set(name, { r: false, w: false, direct: false });
    }
  }
  return { varInfo, periphInfo, periphFieldInfo, periphFlagInfo, periphAddrRefInfo, armInfo };
}

async function buildLevel0Diagram(funcs, varDefs, peripherals, hotCut) {
  const entries = [...funcs.values()].filter(f => f.isEntry || f.isISR);
  if (entries.length === 0) return null;

  const allInfo = aggregateEntryInfo(funcs, entries, e => [...e.calls]);
  const all = assembleLevel0(varDefs, peripherals, hotCut, entries, allInfo, 'a');
  const { svgs: rawSvgs, hasVars } = await renderDotAll(all.nodeLines, all.edgeLines, all.varNodeLines, all.varEdgeLines);
  const svgs = {};
  for (const [k, v] of Object.entries(rawSvgs)) {
    svgs[k] = stripXmlProlog(injectPeriphDetailLabels(bendAntiParallelEdges(v), all.edgeDetails));
  }
  // "DMA-потоки" toggle: a second, independently pre-rendered layout per
  // variant with the CPAR/CMAR source/destination edges (and whatever
  // peripheral/var nodes they force onto the diagram) included — same
  // pre-render-both-states approach as the vars/novars split in renderDotAll.
  // Off by default so a project with no DMA usage never shows the checkbox
  // at all. Verbatim port of the CLI's index.mjs.
  let hasDma = false;
  async function renderDmaVariant(info, idPrefix, suffix) {
    const v = assembleLevel0(varDefs, peripherals, hotCut, entries, info, idPrefix, true);
    if (!v.hasDma) return;
    hasDma = true;
    const r = await renderDotAll(v.nodeLines, v.edgeLines, v.varNodeLines, v.varEdgeLines);
    for (const [k, val] of Object.entries(r.svgs)) {
      svgs[withVariantSuffix(k, suffix + '_dma')] = stripXmlProlog(injectPeriphDetailLabels(bendAntiParallelEdges(val), v.edgeDetails));
    }
  }
  await renderDmaVariant(allInfo, 'a', '');

  // Two independent seeds, each rendered as its own *inclusive* reachability
  // diagram. cyclic seed: entries whose own top-level infinite loop was
  // found start from *just* that loop's own calls; ISRs always use their
  // whole tree (an ISR firing at all *is* the cyclic/runtime behavior, no
  // setup phase of its own). setup seed: an entry's own direct calls that
  // are *not* inside its loop — the one-time boot-phase calls.
  const cyclicInfo = aggregateEntryInfo(funcs, entries, e => (e.isISR ? [...e.calls] : (e.hasLoop ? [...e.loopCalls] : [...e.calls])));
  const setupInfo = aggregateEntryInfo(
    funcs, entries,
    e => (e.isISR ? [] : [...e.calls].filter(c => !e.loopCalls.has(c))),
    e => !e.isISR,
  );

  async function renderVariant(info, idPrefix, suffix) {
    const v = assembleLevel0(varDefs, peripherals, hotCut, entries, info, idPrefix);
    const r = await renderDotAll(v.nodeLines, v.edgeLines, v.varNodeLines, v.varEdgeLines);
    for (const [k, val] of Object.entries(r.svgs)) {
      svgs[withVariantSuffix(k, suffix)] = stripXmlProlog(injectPeriphDetailLabels(bendAntiParallelEdges(val), v.edgeDetails));
    }
    return { v, r };
  }

  const { v: cyclic } = await renderVariant(cyclicInfo, 'c', '_cyclic');
  await renderDmaVariant(cyclicInfo, 'c', '_cyclic');
  const { v: setupOnly } = await renderVariant(setupInfo, 's', '_setuponly');
  await renderDmaVariant(setupInfo, 's', '_setuponly');

  // "neither checked" (both cyclic and setup unchecked in the webview) is
  // the genuine set relationship worth computing: peripherals/vars reachable
  // from *both* seeds — touched during setup and again at runtime.
  const cyclicUsed = usedNames(peripherals, cyclicInfo, entries, true, true);
  const setupUsed = usedNames(peripherals, setupInfo, entries, false, true);
  const overlapPeriphs = new Set([...cyclicUsed.periphs].filter(n => setupUsed.periphs.has(n)));
  const overlapVars = new Set([...cyclicUsed.vars].filter(n => setupUsed.vars.has(n)));
  const overlapInfo = mergeFilteredInfo(entries, overlapPeriphs, overlapVars, cyclicInfo, setupInfo);
  const { v: overlap } = await renderVariant(overlapInfo, 'o', '_overlap');
  await renderDmaVariant(overlapInfo, 'o', '_overlap');

  return {
    svgs,
    varsToggle: hasVars,
    dmaToggle: hasDma,
    cyclicToggle: entries.some(e => e.isISR || e.hasLoop),
    note: [all.note, cyclic.note, setupOnly.note, overlap.note].filter(Boolean).join('; '),
    extraNodes: { ...all.extraNodes, ...cyclic.extraNodes, ...setupOnly.extraNodes, ...overlap.extraNodes },
  };
}

// ---------------------------------------------------------------------------
// Public entry: parse every file, build the whole-project model (two passes,
// same cross-file name resolution as the CLI), then build the level-0
// diagram + a flat node-info lookup table for hover tooltips.
// ---------------------------------------------------------------------------

export async function buildLevel0({ files }) {
  // --- Pass 1: parse every file -------------------------------------------
  const fileRecords = [];
  for (const file of files) {
    const src = file.text;
    let tree;
    try {
      tree = parseC(src);
    } catch (e) {
      continue; // unparsable file — skip, matching the CLI's console.error+continue
    }
    const root = tree.rootNode;
    const basename = path.basename(file.filePath);
    const commentIdx = buildCommentIndex(root, src.split('\n'));
    const vars = extractFileScopeVars(root, commentIdx);
    const fns = extractFunctions(root).map(f => ({
      name: f.name,
      startLine: f.startLine,
      desc: docCommentFor(f.node, commentIdx),
      ...analyzeFunction(f.node),
    }));
    fileRecords.push({ filePath: file.filePath, basename, funcs: fns, vars });
  }

  // --- Pass 2: build the model (resolve names across files) --------------
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

  const peripherals = new Map();
  function periph(name) {
    if (!peripherals.has(name)) {
      peripherals.set(name, {
        name, readers: new Set(), writers: new Set(), armers: new Set(), isrTargets: new Set(),
        fields: new Map(),
      });
    }
    return peripherals.get(name);
  }

  const allDerefNames = new Set();
  for (const f of fileRecords) for (const fn of f.funcs) for (const n of fn.derefNames) allDerefNames.add(n);

  // A DMA status flag's own macro name always ends in the channel/stream
  // number it belongs to (TCIF4, HTIF4, ...) — reads the target off the
  // flag's own text, never invents a node purely from naming convention.
  function dmaChannelTarget(busName, flagName) {
    const m = /(\d+)$/.exec(flagName);
    if (!m) return null;
    const n = m[1];
    const channel = `${busName}_Channel${n}`;
    if (allDerefNames.has(channel)) return channel;
    const stream = `${busName}_Stream${n}`;
    if (allDerefNames.has(stream)) return stream;
    return null;
  }

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
        key, name: fn.name, file: f.basename, filePath: f.filePath, startLine: fn.startLine,
        signature: fn.signature, desc: fn.desc || '',
        isISR: ISR_RE.test(fn.name), isEntry: fn.name === 'main',
        calls: new Set(),
        extCalls: new Set(),
        callers: new Set(),
        access: new Map(),
        periphAccess: new Map(),
        periphFields: new Map(),
        periphFlags: new Map(),
        periphAddrRefs: new Map(),
        arms: new Set(),
        loopCalls: new Set(),
        hasLoop: fn.hasLoop,
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
      for (const calleeName of fn.loopCallNames) {
        const candidates = functionsByName.get(calleeName);
        if (candidates && candidates.length > 0) {
          const target = candidates.find(c => c.basename === f.basename) || candidates[0];
          const calleeKey = funcKey(calleeName, target.basename);
          if (calleeKey !== rec.key) rec.loopCalls.add(calleeKey);
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
          const target = functionsByName.get(name).find(c => c.basename === f.basename)
            || functionsByName.get(name)[0];
          const calleeKey = funcKey(name, target.basename);
          if (calleeKey !== rec.key) rec.calls.add(calleeKey);
          continue;
        }
        if (externNames.has(name)) {
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
          continue;
        }
        if (fn.derefNames.has(name)) {
          const flds = fn.derefFields.get(name);
          const flagsByField = fn.derefFlags.get(name);
          const isDmaBus = DMA_BUS_RE.test(name);

          const buckets = new Map();
          function bucket(t) {
            let b = buckets.get(t);
            if (!b) { b = { fields: new Map(), flags: new Map() }; buckets.set(t, b); }
            return b;
          }

          if (flds) {
            for (const [field, fm] of flds) {
              const flagRec = flagsByField && flagsByField.get(field);
              let residual = fm;
              // 'r' stays a Set(flagName), 'w' is now a Map(flagName ->
              // 'set'|'clear'|'both') — handled separately since their
              // element shapes differ.
              if (isDmaBus && flagRec) {
                if (flagRec.r && flagRec.r.size) {
                  residual = residual.replace('r', '');
                  for (const flag of flagRec.r) {
                    const chan = dmaChannelTarget(name, flag);
                    const b = bucket(chan || name);
                    b.fields.set(field, mergeMode(b.fields.get(field), 'r'));
                    if (!b.flags.has(field)) b.flags.set(field, { r: new Set(), w: new Map() });
                    b.flags.get(field).r.add(flag);
                  }
                }
                if (flagRec.w && flagRec.w.size) {
                  residual = residual.replace('w', '');
                  for (const [flag, polarity] of flagRec.w) {
                    const chan = dmaChannelTarget(name, flag);
                    const b = bucket(chan || name);
                    b.fields.set(field, mergeMode(b.fields.get(field), 'w'));
                    if (!b.flags.has(field)) b.flags.set(field, { r: new Set(), w: new Map() });
                    mergeFlagPolarity(b.flags.get(field).w, flag, polarity);
                  }
                }
              }
              if (residual) {
                const b = bucket(name);
                b.fields.set(field, mergeMode(b.fields.get(field), residual));
                if (flagRec) {
                  if (!b.flags.has(field)) b.flags.set(field, { r: new Set(), w: new Map() });
                  const cur = b.flags.get(field);
                  if (residual.includes('r') && flagRec.r) for (const fl of flagRec.r) cur.r.add(fl);
                  if (residual.includes('w') && flagRec.w) {
                    for (const [fl, pol] of flagRec.w) mergeFlagPolarity(cur.w, fl, pol);
                  }
                }
              }
            }
          } else {
            bucket(name);
          }

          for (const [tName, b] of buckets) {
            const p = periph(tName);
            let tr = false, tw = false;
            for (const fm of b.fields.values()) { if (fm.includes('r')) tr = true; if (fm.includes('w')) tw = true; }
            if (!b.fields.size) { tr = mode.r; tw = mode.w; }
            const tm = (tr ? 'r' : '') + (tw ? 'w' : '');
            const prev = rec.periphAccess.get(tName);
            rec.periphAccess.set(tName, prev && prev !== tm ? 'rw' : (tm || 'r'));
            if (tr) p.readers.add(rec.key);
            if (tw) p.writers.add(rec.key);
            if (b.fields.size) {
              let rf = rec.periphFields.get(tName);
              if (!rf) { rf = new Map(); rec.periphFields.set(tName, rf); }
              for (const [field, fm] of b.fields) {
                rf.set(field, mergeMode(rf.get(field), fm));
                p.fields.set(field, mergeMode(p.fields.get(field), fm));
              }
            }
            if (b.flags.size) {
              let rflag = rec.periphFlags.get(tName);
              if (!rflag) { rflag = new Map(); rec.periphFlags.set(tName, rflag); }
              for (const [field, perKind] of b.flags) {
                if (!rflag.has(field)) rflag.set(field, { r: new Set(), w: new Map() });
                const cur = rflag.get(field);
                for (const fl of perKind.r) cur.r.add(fl);
                for (const [fl, pol] of perKind.w) mergeFlagPolarity(cur.w, fl, pol);
              }
            }
            // CPAR/CMAR address refs are keyed off the literal derefName they
            // were found on — they only ever live on the bucket that
            // resolved to that exact same name (never a DMA-bus redirect
            // target; CPAR/CMAR live on the channel's own name, which never
            // matches DMA_BUS_RE in the first place).
            if (tName === name) {
              const addrRefs = fn.derefAddrRefs.get(name);
              if (addrRefs && addrRefs.size) {
                let ra = rec.periphAddrRefs.get(tName);
                if (!ra) { ra = new Map(); rec.periphAddrRefs.set(tName, ra); }
                for (const [field, ref] of addrRefs) {
                  // a 'var' ref only ever carries the bare identifier text at
                  // this point (resolveAddrExpr has no file context) —
                  // resolve it to a real varKey now, same rule as any other
                  // access (resolveVar), and drop it if it doesn't name an
                  // actual global/static.
                  if (ref.kind === 'var') {
                    const vk = resolveVar(ref.name, f.basename);
                    if (vk) ra.set(field, { kind: 'var', key: vk });
                  } else {
                    ra.set(field, ref);
                  }
                }
              }
            }
          }
          continue;
        }
        // anything else: macro / enum constant -> ignore
      }

      for (const irqRaw of fn.armCalls) {
        const name = irqRaw.replace(/_IRQn$/, '');
        if (!name) continue;
        const p = periph(name);
        p.armers.add(rec.key);
        rec.arms.add(name);

        // NVIC itself never becomes a real peripheral node the normal way —
        // synthesized so it renders/groups/hover-reveals like any other
        // peripheral. "IRQ_" is a throwaway one-segment prefix (shortFlagName
        // always strips exactly the first segment for display).
        const nvic = periph('NVIC');
        nvic.writers.add(rec.key);
        nvic.fields.set('ISER', mergeMode(nvic.fields.get('ISER'), 'w'));
        const prevNvic = rec.periphAccess.get('NVIC');
        rec.periphAccess.set('NVIC', prevNvic && prevNvic !== 'w' ? 'rw' : 'w');
        let nvicFields = rec.periphFields.get('NVIC');
        if (!nvicFields) { nvicFields = new Map(); rec.periphFields.set('NVIC', nvicFields); }
        nvicFields.set('ISER', mergeMode(nvicFields.get('ISER'), 'w'));
        let nvicFlags = rec.periphFlags.get('NVIC');
        if (!nvicFlags) { nvicFlags = new Map(); rec.periphFlags.set('NVIC', nvicFlags); }
        if (!nvicFlags.has('ISER')) nvicFlags.set('ISER', { r: new Set(), w: new Map() });
        mergeFlagPolarity(nvicFlags.get('ISER').w, `IRQ_${irqRaw}`, 'set');
      }
    }
  }

  for (const fn of funcs.values()) {
    for (const calleeKey of fn.calls) {
      const callee = funcs.get(calleeKey);
      if (callee) callee.callers.add(fn.key);
    }
  }

  // A peripheral's name matches the IRQ-handler naming convention when the
  // handler's base name contains the peripheral name as a whole
  // underscore-delimited segment or run (also covers shared vectors naming
  // several peripherals at once). Only adds the trigger edge, never creates
  // the node.
  function isrBaseName(name) {
    return name.replace(/^ISR_/, '').replace(/(_IRQHandler|_Handler|_ISR)$/, '');
  }
  for (const fn of funcs.values()) {
    if (!fn.isISR) continue;
    const base = isrBaseName(fn.name);
    if (!base) continue;
    for (const p of peripherals.values()) {
      if (base === p.name || base.startsWith(p.name + '_') || base.endsWith('_' + p.name)
          || base.includes('_' + p.name + '_')) {
        p.isrTargets.add(fn.key);
      }
    }
  }

  // --- Importance of globals: hotCut for varTier/sizeTier -----------------
  for (const v of varDefs.values()) {
    const users = new Set([...v.readers, ...v.writers]);
    const files = new Set([...users].map(k => funcs.get(k)?.file).filter(Boolean));
    v.users = users.size;
    v.score = users.size + Math.max(0, files.size - 1) + (v.isVolatile ? 2 : 0);
  }
  const varScores = [...varDefs.values()].filter(v => !v.isExternal)
    .map(v => v.score).sort((a, b) => a - b);
  const hotCut = varScores.length
    ? Math.max(4, varScores[Math.min(varScores.length - 1, Math.floor(varScores.length * 0.8))])
    : Infinity;

  // --- Build the diagram ---------------------------------------------------
  const level0 = await buildLevel0Diagram(funcs, varDefs, peripherals, hotCut);
  if (!level0) return null;

  // --- Flat node-info lookup table for hover tooltips ---------------------
  const fnName = k => funcs.get(k)?.name || k;
  const nodeInfo = {};
  for (const fn of funcs.values()) {
    if (!fn.isEntry && !fn.isISR) continue; // level 0 never draws a plain function node
    nodeInfo[fnId(fn.key)] = {
      label: fn.name, kind: fn.isISR ? 'isr' : 'entry',
      file: fn.file, filePath: fn.filePath, startLine: fn.startLine,
      sig: fn.signature, desc: fn.desc || undefined,
    };
  }
  for (const v of varDefs.values()) {
    nodeInfo[varId(v.key)] = {
      label: v.name, kind: v.isExternal ? 'extvar' : v.isVolatile ? 'gvolatile' : 'gvar',
      file: v.file || undefined, type: v.typeText || undefined,
      static: v.isStatic || undefined, volatile: v.isVolatile || undefined,
      desc: v.desc || undefined, users: v.users || undefined,
      writers: [...v.writers].map(fnName), readers: [...v.readers].map(fnName),
    };
  }
  for (const p of peripherals.values()) {
    nodeInfo[periphId(p.name)] = {
      label: p.name, kind: 'periph',
      writers: [...p.writers].map(fnName), readers: [...p.readers].map(fnName),
      armers: [...p.armers].map(fnName), isrTargets: [...p.isrTargets].map(fnName),
    };
  }
  Object.assign(nodeInfo, level0.extraNodes);

  return {
    svgs: level0.svgs,
    nodeInfo,
    varsToggle: level0.varsToggle,
    cyclicToggle: level0.cyclicToggle,
    dmaToggle: level0.dmaToggle,
    note: level0.note,
  };
}

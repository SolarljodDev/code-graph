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
  // a local pointer's own initializer, resolved one level deep — see
  // resolveLocalAlias — so `X->CMAR = m->data` can be traced through
  // `U1Msg *m = &u1_q[u1_q_tail];` back to `u1_q`, the same way a direct
  // `X->CMAR = u1_rx_buf` already resolves. name -> {kind, name/key, field}
  const localAliases = new Map();
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
          if (nm && d.type === 'init_declarator') {
            const value = d.childForFieldName('value');
            const ref = value && resolveAddrExpr(value);
            if (ref) localAliases.set(nm, ref);
          }
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
                const ref = resolveLocalAlias(resolveAddrExpr(right), locals, localAliases);
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

// Strips a DMA CPAR/CMAR assignment's right-hand side (or a local pointer's
// own initializer — see resolveLocalAlias) down to the expression that
// actually names the source/destination address — casts and parens first,
// then, if what's left is `&something`, unwraps that one layer too, then
// unwraps one `[index]` layer the same way (`&u1_q[u1_q_tail]` names the
// array `u1_q`, whichever slot). What remains is classified: a `->` field
// access names the peripheral it's rooted at (`field` is kept too, for the
// hover-detail label — see dotDmaFlowEdge) and a bare identifier names a var
// — this doesn't yet know whether that base name is itself a global or a
// local pointer/array (e.g. `m` in `m->data`); the caller resolves that
// ambiguity via resolveLocalAlias. Verbatim port of the CLI's index.mjs.
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
  if (n.type === 'subscript_expression') {
    n = n.childForFieldName('argument');
    while (n && n.type === 'parenthesized_expression') n = n.namedChildren[0];
  }
  if (!n) return null;
  if (n.type === 'field_expression' && n.childForFieldName('operator')?.text === '->') {
    const base = n.childForFieldName('argument');
    return base && base.type === 'identifier'
      ? { kind: 'periph', name: base.text, field: n.childForFieldName('field')?.text }
      : null;
  }
  if (n.type === 'identifier') return { kind: 'var', name: n.text };
  return null;
}
// Follows resolveAddrExpr's result one step further when it turns out to
// name a local, not a real global/peripheral — `m->data` off
// `U1Msg *m = &u1_q[u1_q_tail];` first resolves (structurally) to
// {kind:'periph', name:'m', field:'data'}, since resolveAddrExpr alone can't
// tell a peripheral register block apart from a local struct pointer by AST
// shape; `m` being in `locals` is exactly that tell. localAliases (built once
// per function, see analyzeFunction) already carries `m`'s own resolved
// initializer, one level deep — not re-resolved recursively here. Verbatim
// port of the CLI's index.mjs.
function resolveLocalAlias(ref, locals, localAliases) {
  if (!ref) return null;
  return locals.has(ref.name) ? (localAliases.get(ref.name) || null) : ref;
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

function dotVarNode(v, hotCut, { tiered = false, ghost = false, withFile = false, extraClass = '' } = {}) {
  const kind = v.isExternal ? 'ext var' : v.isVolatile ? 'volatile' : 'var';
  let cls = ghost || v.isExternal ? 'ghost' : 'gvar';
  if (tiered && !ghost && !v.isExternal) {
    const tier = varTier(v, hotCut);
    if (tier === 'hot') cls = 'gvarhot'; else if (tier === 'minor') cls = 'gvarminor';
  }
  if (extraClass) cls += ' ' + extraClass;
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
  if (!fields || !fields.size) return { detail: '', hasEnable: false, enableLabel: '', readLabel: '' };
  const regs = [...fields.entries()].filter(([, m]) => m.includes(dir)).map(([f]) => f).sort();
  if (!regs.length) return { detail: '', hasEnable: false, enableLabel: '', readLabel: '' };
  let hasEnable = false, enableLabel = '';
  const names = regs.map(reg => {
    const bits = flags && flags.get(reg) && flags.get(reg)[dir];
    if (bits && bits.size) {
      if (dir === 'w') {
        // bits: Map(flagName -> 'set'|'clear'|'both') — a bit only ever
        // cleared here (`&= ~FLAG`, never `|= FLAG` anywhere in the same
        // tree) gets a literal ~ prefix so it reads as "turned off", not
        // "turned on". 'both' shows *both* forms, clear before set — the
        // actual disable-then-rearm sequence for the common case where
        // they're both in the one function this detail is for; across a
        // whole reachable call tree there's no single well-defined order, so
        // this is a reasonable default reading, not a claimed causal fact.
        // Verbatim port of the CLI's index.mjs.
        const sorted = [...bits.keys()].sort();
        if (!hasEnable) {
          // excludes pure-'clear' bits — this label means "this edge arms
          // the peripheral", and a bit only ever cleared here does the
          // opposite.
          const enableBit = sorted.find(fl => isEnableFlagName(fl) && bits.get(fl) !== 'clear');
          if (enableBit) { hasEnable = true; enableLabel = shortFlagName(enableBit); }
        }
        return sorted.map(fl => {
          const short = shortFlagName(fl);
          const pol = bits.get(fl);
          return pol === 'both' ? `~${short}, ${short}` : (pol === 'clear' ? '~' : '') + short;
        }).join(', ');
      }
      const sorted = [...bits].sort();
      return sorted.map(shortFlagName).join(', ');
    }
    return reg;
  });
  const shown = names.slice(0, cap);
  if (names.length > cap) shown.push(`+${names.length - cap}`);
  // Read's analogue of the write side's enable-bit hint: a single specific
  // flag being tested (an ISR checking its own completion/error condition,
  // say) is exactly the "one clear fact" worth showing at rest instead of
  // only on hover — an unlabeled read arrow otherwise looks like it points
  // at nothing in particular (user report 2026-07-21). Multiple registers,
  // or multiple flags on the one register, falls back to hover-only (the
  // detail breakdown above): there's no single bit left to call out as *the*
  // one this edge is about.
  let readLabel = '';
  if (dir === 'r' && regs.length === 1) {
    const bits = flags && flags.get(regs[0]) && flags.get(regs[0]).r;
    if (bits && bits.size === 1) readLabel = shortFlagName([...bits][0]);
  }
  return { detail: shown.join('\\n'), hasEnable, enableLabel, readLabel };
}
function dotPeriphNode(p, { extraClass = '' } = {}) {
  const hot = p.isrTargets.size > 0 && (p.readers.size + p.writers.size) > 0;
  const cls = (hot ? 'periphhot' : 'periph') + (extraClass ? ' ' + extraClass : '');
  return dotNode(periphId(p.name), [dotKindRow('периферия'), `<B>${dotEsc(p.name)}</B>`], 'hexagon', cls);
}
function dotVarBundleNode(id, vars, tier) {
  let cls = 'gvar';
  if (tier === 'hot') cls = 'gvarhot'; else if (tier === 'minor') cls = 'gvarminor';
  const rows = vars.map(v => v.name).sort().map(name => `<B>${dotEsc(name)}</B>`);
  return dotNode(id, rows, 'cylinder', cls);
}

function dotEdge(from, to, { dir = 'forward', style, label, penwidth, id, color, cls, constraint } = {}) {
  const attrs = [`dir=${dir}`];
  if (id) attrs.push(`id="${dotEsc(id)}"`);
  if (constraint === false) attrs.push('constraint=false');
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
function dotAccessLink(fnKey, targetId, direct, downstream, cls) {
  const a = fnId(fnKey);
  const [from, to] = downstream ? [a, targetId] : [targetId, a];
  return dotEdge(from, to, { dir: 'none', style: direct ? undefined : 'dashed', cls });
}
// 0-2 directed edges per peripheral (never dir=both) — solid=write
// (entry->periph), dashed=read (periph->entry). Default label is the write
// side's enable bit, or the read side's one specific flag, whenever
// periphDirDetail found a single clear fact worth naming — otherwise blank,
// hover-only; the full register/flag breakdown rides along in `details` for
// injectPeriphDetailLabels to splice into the SVG as a hidden hover-reveal
// (see the CSS .periph-detail/.periph-default pair, ported into graph-view.css).
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
    lines.push(dotEdge(b, a, { style: 'dashed', label: r.readLabel || ' ', id }));
    details.push({ id, defaultLabel: r.readLabel, detail: r.detail });
  }

  return { lines, details };
}

// A DMA channel's data source/destination — a different relationship from
// the plain register read/write edges above ("who touched this register" vs
// "where does the data physically end up") — so it gets its own color
// rather than reusing solid=write/dashed=read. Direction follows the
// transfer's real direction (source -> channel -> destination). label is the
// register the address came from (CPAR/CMAR itself), shown small and
// always-visible; detail is the *concrete* thing that register resolved to —
// the specific peripheral register for a CPAR edge (e.g. "DR") or the
// variable's own name for a CMAR edge — revealed on hover via the same
// .periph-detail/.periph-default mechanism as dotPeriphAccessEdges. Pass
// detail only when there's something worth revealing. Verbatim port of the
// CLI's index.mjs.
const DMA_FLOW_COLOR = '#0d9488';
function dotDmaFlowEdge(fromId, toId, label, id, detail) {
  const line = dotEdge(fromId, toId, { style: 'dashed', label, id, color: DMA_FLOW_COLOR, cls: 'dma-flow' });
  return { line, detail: detail ? { id, defaultLabel: label, detail } : null };
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

// Rough glyph-width estimate (Segoe UI/Helvetica at this weight averages
// ~0.58em per character) for growCanvasForLabels' overflow check below —
// doesn't need to be exact, only wide enough that a real clip never slips
// through as a false negative.
function textHalfWidth(text, fontSize) { return text.length * fontSize * 0.58 / 2 + 2; }

// svg's own header, parsed once per render: viewBox's origin/size, the
// physical width/height (same units, usually "pt"), and the root <g>'s
// translate — every <text> x/y injectPeriphDetailLabels places is in that
// same pre-translate coordinate space, so screen position = translate + x/y.
function svgFrame(svg) {
  const tag = svg.match(/<svg\b[^>]*>/);
  const vb = tag && tag[0].match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/);
  const wh = tag && tag[0].match(/width="([\d.]+)(\w*)"\s+height="([\d.]+)(\w*)"/);
  const g = svg.match(/<g[^>]*\btransform="[^"]*translate\((-?[\d.]+)[ ,]+(-?[\d.]+)\)/);
  if (!vb || !wh || !g) return null;
  return {
    vbX: parseFloat(vb[1]), vbY: parseFloat(vb[2]), vbW: parseFloat(vb[3]), vbH: parseFloat(vb[4]),
    w: parseFloat(wh[1]), wUnit: wh[2], h: parseFloat(wh[3]), hUnit: wh[4],
    tx: parseFloat(g[1]), ty: parseFloat(g[2]),
  };
}
// injectPeriphDetailLabels pushes each label away from its edge (perpendicular
// offset below) into whatever space happens to be there — graphviz sized the
// canvas for the *original*, unpushed label position, so a peripheral sitting
// near the diagram's own boundary (common: peripheral hexagons are often leaf
// nodes at the graph's edge) gets its pushed label clipped by the SVG's own
// default viewport clipping (user report 2026-07-21: a DMA channel's
// single-flag read label, e.g. "ISR_TCIF4", cut off at the top). Grows the
// viewBox/width/height to cover every pushed label's estimated extent;
// never shrinks, and is a no-op when nothing actually overflows.
function growCanvasForLabels(svg, frame, extents) {
  if (!frame || !extents.length) return svg;
  let left = 0, right = 0, top = 0, bottom = 0;
  for (const { x, y, halfW, ascent, descent } of extents) {
    const sx = frame.tx + x, sy = frame.ty + y;
    left = Math.max(left, frame.vbX - (sx - halfW));
    right = Math.max(right, (sx + halfW) - (frame.vbX + frame.vbW));
    top = Math.max(top, frame.vbY - (sy - ascent));
    bottom = Math.max(bottom, (sy + descent) - (frame.vbY + frame.vbH));
  }
  if (left <= 0 && right <= 0 && top <= 0 && bottom <= 0) return svg;
  const newVbX = frame.vbX - left, newVbY = frame.vbY - top;
  const newVbW = frame.vbW + left + right, newVbH = frame.vbH + top + bottom;
  const newW = frame.w + left + right, newH = frame.h + top + bottom;
  return svg.replace(/<svg\b[^>]*>/, tag => tag
    .replace(/width="[\d.]+(\w*)"/, `width="${newW.toFixed(2)}$1"`)
    .replace(/height="[\d.]+(\w*)"/, `height="${newH.toFixed(2)}$1"`)
    .replace(/viewBox="-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+"/,
      `viewBox="${newVbX.toFixed(2)} ${newVbY.toFixed(2)} ${newVbW.toFixed(2)} ${newVbH.toFixed(2)}"`));
}
function injectPeriphDetailLabels(svg, details) {
  if (!details.length) return svg;
  const frame = svgFrame(svg);
  const extents = [];
  for (const { id, detail } of details) {
    // class="edge[^"]* — not a literal "edge": a DMA-flow edge's class is
    // "edge dma-flow" (dotDmaFlowEdge's cls, needed for media/level0.css to
    // override the theme-aware default edge color), which a literal
    // class="edge" match would silently skip, dropping its hover-detail.
    const re = new RegExp(`(<g id="${id}" class="edge[^"]*">[\\s\\S]*?)(<text([^>]*)>([^<]*)<\\/text>)`);
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
    const defaultAttrs = attrs
      .replace(/ x="[^"]+"/, ` x="${near.x.toFixed(2)}"`)
      .replace(/ y="[^"]+"/, ` y="${near.y.toFixed(2)}"`);
    const fsMatch = attrs.match(/font-size="([\d.]+)"/);
    const fontSize = fsMatch ? parseFloat(fsMatch[1]) : 10;
    const ascent = fontSize * 0.8, descent = fontSize * 0.25;
    extents.push({ x: near.x, y: near.y, halfW: textHalfWidth(m[4], fontSize), ascent, descent });

    // The hide-default/reveal-detail swap on hover only earns its keep when
    // there's genuinely more in `detail` than the default already shows
    // (write edges with several registers/flags, say). When the whole detail
    // is the exact one line already sitting there as the default (the common
    // single-flag read case, e.g. "ISR_TCIF4"), swapping it out for an
    // *identical* copy on hover has nothing to add — it's pure surface area
    // for a hover-triggered glitch with zero payoff (user report 2026-07-21:
    // the label vanishing on hover instead of just staying put). Left as one
    // permanently-visible label instead — never hidden, at rest or on hover
    // — so there's no swap for anything to go wrong with.
    if (lines.length === 1 && m[4] === dotEsc(lines[0])) {
      const replacement = m[1] + `<text class="periph-static"${defaultAttrs}>${m[4]}</text>`;
      svg = svg.slice(0, m.index) + replacement + svg.slice(m.index + m[0].length);
      continue;
    }

    const far = pushLabelPerp(pathD, origX, origY, PERIPH_LABEL_PUSH_NEAR + PERIPH_LABEL_PUSH_PER_LINE * lines.length);
    const dy = 12;
    const baseY = far.y - dy * (lines.length - 1) / 2;
    const detailBaseAttrs = attrs.replace(/ x="[^"]+"/, ` x="${far.x.toFixed(2)}"`);
    const detailTexts = lines.map((line, i) => {
      const y = baseY + dy * i;
      const lineAttrs = detailBaseAttrs.replace(/ y="[^"]+"/, ` y="${y.toFixed(2)}"`);
      extents.push({ x: far.x, y, halfW: textHalfWidth(line, fontSize), ascent, descent });
      return `<text class="periph-detail"${lineAttrs}>${dotEsc(line)}</text>`;
    }).join('');
    // Read-direction edges carry no default hint at all (only write edges'
    // enable-bit callout does) — dotPeriphAccessEdges still gives them a
    // literal-space label so graphviz reserves a text anchor here for the
    // hover-reveal detail above to attach to, but that blank placeholder has
    // nothing to show, ever. Reusing periph-default's own class on it (as
    // this used to do unconditionally) forced graph-view.css's "periph
    // default hints stay visible at rest" rule onto whitespace, which
    // shouldn't matter visually but is exactly the kind of place a rendering
    // quirk (a stray mark where a blank space "should" be invisible either
    // way) would show up — user report 2026-07-21. Falls back to the plain
    // (always-hidden-at-rest) edge-text rule instead when there's nothing to
    // show by default.
    const hasDefault = m[4] && m[4].trim().length > 0;
    const defaultCls = hasDefault ? ' class="periph-default"' : '';
    const replacement = m[1] + `<text${defaultCls}${defaultAttrs}>${m[4]}</text>` + detailTexts;
    svg = svg.slice(0, m.index) + replacement + svg.slice(m.index + m[0].length);
  }
  return growCanvasForLabels(svg, frame, extents);
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
function assembleLevel0(varDefs, peripherals, hotCut, entries, info, idPrefix, includeDma = false, dmaFacts = null) {
  const { varInfo, periphInfo, periphFieldInfo, periphFlagInfo } = info;

  // A var CMAR resolves to must never also qualify as a normal cross-entry
  // singleton/bundle var (below) — if it did, resolveDmaRef's own
  // reader/writer edges got skipped as a would-be duplicate of the
  // singleton's, but the singleton's edges live in the vars-gated bucket
  // (varEdgeLines), so unchecking "переменные" silently dropped them —
  // exactly the buffer-to-function edges "DMA-потоки" exists to show. Bug
  // found by the user 2026-07-20: u1_q happens to also pass the normal
  // "written by one entry, read by a different one" filter (uart1_send
  // writes it, u1_kick reads it), so its reader/writer edges vanished under
  // "переменные" off even though the node itself (forced core) stayed.
  // Excluding it here instead means every DMA-target var is *always*
  // handled by resolveDmaRef's own path, never the singleton/bundle one, so
  // there's no duplicate to guard against and nothing var-toggle-gated.
  // Verbatim port of the CLI's index.mjs.
  const dmaTargetVarKeys = new Set();
  if (includeDma && dmaFacts) {
    for (const refs of dmaFacts.addrRefs.values()) {
      for (const ref of refs.values()) if (ref.kind === 'var') dmaTargetVarKeys.add(ref.key);
    }
  }

  const allVarKeys = new Set();
  for (const acc of varInfo.values()) for (const vk of acc.keys()) allVarKeys.add(vk);
  const showVars = [...allVarKeys].filter(vk => {
    if (!varDefs.has(vk) || dmaTargetVarKeys.has(vk)) return false;
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

  // DMA channel data-flow edges — see resolveAddrExpr/computeDmaFacts: which
  // peripheral/global buffer a channel's CPAR/CMAR resolves to, and (via the
  // CCR DIR bit) which direction the transfer runs. dmaFacts is precomputed
  // once (from the unfiltered "all" reachability, see buildLevel0Diagram) and
  // shared by every variant's DMA render — never recomputed from *this*
  // variant's own (possibly filtered) info; see computeDmaFacts for why.
  // Verbatim port of the CLI's index.mjs.
  let hasDma = false;
  if (includeDma) {
    const forcedDmaIds = new Set();
    // resolves a CPAR/CMAR ref to a node id, forcing a node onto the diagram
    // if the target isn't on it already — always the entity's own regular id
    // (periphId/varId), never a synthetic one, since buildLevel0's nodeInfo
    // already carries full hover metadata for *every* peripheral/var in the
    // whole project, not just ones some diagram happens to draw a node for —
    // reusing the real id gets that metadata for free. Pushed onto nodeLines
    // (the core bucket) even for a var, not varNodeLines — a DMA buffer
    // should stay visible under "DMA-потоки" regardless of the separate
    // "переменные" toggle (user request 2026-07-20: unchecking "переменные"
    // was hiding DMA buffers too, since they used to live in the same
    // vars-gated bucket as the normal cross-entry variable bundles). A var
    // CMAR resolves to can never also be a normal singleton/bundle var
    // (dmaTargetVarKeys excludes it from showVars above), so there's no
    // duplicate node/edge case to guard against here. Verbatim port of the
    // CLI's index.mjs.
    function resolveDmaRef(ref) {
      if (!ref) return null;
      if (ref.kind === 'periph') {
        const target = peripherals.get(ref.name);
        if (!target) return null;
        const id = periphId(ref.name);
        // Only ever reached when this peripheral didn't otherwise earn a
        // node (the `!periphList.includes` guard) — so a node pushed here
        // is, by construction, "dma-flow"-exclusive: safe to always tag for
        // masking, no risk of hiding a node that's independently relevant
        // too (that case reuses the existing periphList node instead).
        if (!periphList.includes(target) && !forcedDmaIds.has(id)) {
          nodeLines.push(dotPeriphNode(target, { extraClass: 'dma-flow' }));
          forcedDmaIds.add(id);
        }
        return id;
      }
      const v = varDefs.get(ref.key);
      if (!v) return null;
      const id = varId(ref.key);
      if (!forcedDmaIds.has(id)) {
        // Every var reaching this branch is, by construction, DMA-exclusive
        // — dmaTargetVarKeys (above) always excludes it from the normal
        // singleton/bundle path, so unlike the periph case there's no
        // "already independently relevant" branch to worry about here.
        nodeLines.push(dotVarNode(v, hotCut, { tiered: true, extraClass: 'dma-flow' }));
        forcedDmaIds.add(id);
        // DMA hardware writes this buffer directly — the code itself never
        // assigns to it, so it never earns the normal cross-entry "written
        // by one entry, read by a different one" filter (showVars) on its
        // own. Wired up here exactly like a normal singleton var
        // (dotAccessLink), so hovering it shows the functions that actually
        // read/write it, not just the DMA channel it's plumbed into — user
        // request 2026-07-20. Tagged dma-flow too (unlike a normal
        // dotAccessLink) so it masks along with the node it points at,
        // rather than dangling once that node's hidden.
        for (const e of entries) {
          const a = varInfo.get(e.key)?.get(ref.key);
          if (!a) continue;
          edgeLines.push(dotAccessLink(e.key, id, a.direct, false, 'dma-flow'));
          connectedEntries.add(e.key);
        }
      }
      return id;
    }
    for (const p of periphList) {
      const refs = dmaFacts.addrRefs.get(p.name);
      if (!refs) continue;
      const cparRef = refs.get('CPAR'), cmarRef = refs.get('CMAR');
      if (!cparRef && !cmarRef) continue;
      // DMA_CCR_DIR set (or set-and-cleared, i.e. genuinely armed at some
      // point) means memory -> peripheral (TX); unset/absent is the STM32
      // default, peripheral -> memory (RX).
      const ccrDir = dmaFacts.ccrDir.get(p.name);
      const isTx = ccrDir === 'set' || ccrDir === 'both';
      const periphSideId = resolveDmaRef(cparRef);
      const memSideId = resolveDmaRef(cmarRef);
      if (!periphSideId && !memSideId) continue;
      const channelId = periphId(p.name);
      // the concrete thing a ref resolved to, revealed on hover — the
      // specific register for a peripheral ref (dotDmaFlowEdge's own comment
      // explains why CMAR gets one too, not just CPAR).
      function detailFor(ref) {
        if (ref.kind === 'periph') return ref.field || '';
        return varDefs.get(ref.key)?.name || '';
      }
      // Always core (edgeLines), never varEdgeLines — same reasoning as
      // resolveDmaRef pushing var nodes onto nodeLines instead of
      // varNodeLines: a DMA edge (and the buffer it points at) is controlled
      // by "DMA-потоки" alone, not by "переменные" too.
      const push = (ref, edge) => {
        edgeLines.push(edge.line);
        if (edge.detail) edgeDetails.push(edge.detail);
      };
      hasDma = true;
      if (isTx) {
        if (memSideId) push(cmarRef, dotDmaFlowEdge(memSideId, channelId, 'CMAR', `dma_${idPrefix}_${channelId}_cmar`, detailFor(cmarRef)));
        if (periphSideId) push(cparRef, dotDmaFlowEdge(channelId, periphSideId, 'CPAR', `dma_${idPrefix}_${channelId}_cpar`, detailFor(cparRef)));
      } else {
        if (periphSideId) push(cparRef, dotDmaFlowEdge(periphSideId, channelId, 'CPAR', `dma_${idPrefix}_${channelId}_cpar`, detailFor(cparRef)));
        if (memSideId) push(cmarRef, dotDmaFlowEdge(channelId, memSideId, 'CMAR', `dma_${idPrefix}_${channelId}_cmar`, detailFor(cmarRef)));
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

// A DMA channel's CPAR/CMAR wiring and its CCR DIR bit are a fact about the
// channel's hardware setup, not about "cyclic" vs "setup" runtime behavior —
// the address is normally poked once at boot (dma_init), which is exactly
// the code the cyclic-only filtered variant deliberately excludes. Computing
// this from each filtered variant's own (restricted) periphAddrRefInfo/
// periphFlagInfo — as assembleLevel0 originally did — meant checking
// "DMA-потоки" while "цикличное" was the only filter on silently showed
// nothing at all, with no indication why (dma_init is never reachable from
// any entry's *cyclic* seed). Computed once here from the fullest
// reachability available (the unfiltered "all" aggregation) and reused by
// every variant's DMA render instead, so the wiring facts don't flicker in
// and out as the cyclic/setup/overlap checkboxes change — only which
// peripherals/entries are otherwise on the diagram does that. Verbatim port
// of the CLI's index.mjs.
function computeDmaFacts(entries, info) {
  const addrRefs = new Map(); // peripheral name -> Map(field -> ref)
  const ccrDir = new Map();   // peripheral name -> 'set' | 'clear' | 'both'
  for (const e of entries) {
    for (const [pk, refs] of info.periphAddrRefInfo.get(e.key)) {
      let m = addrRefs.get(pk);
      if (!m) { m = new Map(); addrRefs.set(pk, m); }
      for (const [field, ref] of refs) m.set(field, ref);
    }
    for (const [pk, fields] of info.periphFlagInfo.get(e.key)) {
      const ccrW = fields.get('CCR')?.w;
      if (!ccrW) continue;
      for (const [fl, pol] of ccrW) {
        if (!/_DIR$/.test(fl)) continue;
        const prev = ccrDir.get(pk);
        ccrDir.set(pk, prev && prev !== pol ? 'both' : pol);
      }
    }
  }
  return { addrRefs, ccrDir };
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

  // "DMA-потоки" (CPAR/CMAR data-flow edges, plus whichever channel/buffer/
  // peripheral they resolve to) used to be a wholly separate re-laid-out
  // diagram, restricted to cyclic reachability only so main's one-time
  // dma_init setup edge didn't break the view alongside the ISRs (user
  // feedback 2026-07-20). Baked directly into the cyclic *and* setup-only
  // renders below instead (later same-date request, once the checkbox
  // became a client-side mask — see level0.js/level0.css — rather than a
  // graph swap): each keeps its *own* reachability rather than sharing one
  // merged set, so setup-only legitimately shows main's real CPAR/CMAR
  // wiring (it does touch those registers) while cyclic shows only what's
  // actually read/written at runtime (e.g. an ISR's own buffer access) —
  // precisely the two facts the old single merged variant had to choose
  // between. dmaFacts itself (the resolved wiring) still comes from allInfo
  // — dma_init is never cyclic-reachable, so computing it from cyclicInfo
  // alone would find nothing regardless of which variant asks for it later.
  const dmaFacts = computeDmaFacts(entries, allInfo);
  // Project-wide "does DMA addressing show up anywhere at all" — independent
  // of which variant is on screen; alone gates the checkbox's own visibility
  // (dmaToggle below). off by default (no DMA usage anywhere in the
  // project) so the checkbox never shows at all.
  const hasDma = dmaFacts.addrRefs.size > 0;

  async function renderVariant(info, idPrefix, suffix, includeDma = false) {
    const v = assembleLevel0(varDefs, peripherals, hotCut, entries, info, idPrefix, includeDma, includeDma ? dmaFacts : null);
    const r = await renderDotAll(v.nodeLines, v.edgeLines, v.varNodeLines, v.varEdgeLines);
    for (const [k, val] of Object.entries(r.svgs)) {
      svgs[withVariantSuffix(k, suffix)] = stripXmlProlog(injectPeriphDetailLabels(bendAntiParallelEdges(val), v.edgeDetails));
    }
    return { v, r };
  }

  const { v: cyclic } = await renderVariant(cyclicInfo, 'c', '_cyclic', hasDma);
  const { v: setupOnly } = await renderVariant(setupInfo, 's', '_setuponly', hasDma);

  // "neither checked" (both cyclic and setup unchecked in the webview) is
  // the genuine set relationship worth computing: peripherals/vars reachable
  // from *both* seeds — touched during setup and again at runtime.
  const cyclicUsed = usedNames(peripherals, cyclicInfo, entries, true, true);
  const setupUsed = usedNames(peripherals, setupInfo, entries, false, true);
  const overlapPeriphs = new Set([...cyclicUsed.periphs].filter(n => setupUsed.periphs.has(n)));
  const overlapVars = new Set([...cyclicUsed.vars].filter(n => setupUsed.vars.has(n)));
  const overlapInfo = mergeFilteredInfo(entries, overlapPeriphs, overlapVars, cyclicInfo, setupInfo);
  const { v: overlap } = await renderVariant(overlapInfo, 'o', '_overlap');

  return {
    svgs,
    varsToggle: hasVars,
    dmaToggle: hasDma,
    cyclicToggle: entries.some(e => e.isISR || e.hasLoop),
    note: [all.note, cyclic.note, setupOnly.note, overlap.note].filter(Boolean).join('; '),
    extraNodes: {
      ...all.extraNodes, ...cyclic.extraNodes, ...setupOnly.extraNodes, ...overlap.extraNodes,
    },
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

  // --- Per-variable-name usage index, for the CFG ribbon's "this variable
  // also appears in these other functions/files" side list -----------------
  // Keyed by display name rather than varKey: the ribbon only ever has the
  // bare identifier text VS Code reports as selected, and — same as
  // nodeInfo above — a static local in another file sharing that name is a
  // reasonable (if imprecise) thing to surface too, not a bug to guard
  // against.
  const usageByVar = {};
  for (const v of varDefs.values()) {
    const modeByFn = new Map(); // funcKey -> 'r' | 'w' | 'rw'
    for (const k of v.readers) modeByFn.set(k, modeByFn.get(k) === 'w' ? 'rw' : 'r');
    for (const k of v.writers) modeByFn.set(k, modeByFn.get(k) === 'r' ? 'rw' : 'w');
    const entries = [];
    for (const [k, mode] of modeByFn) {
      const fn = funcs.get(k);
      if (!fn) continue;
      entries.push({ name: fn.name, file: fn.file, filePath: fn.filePath, startLine: fn.startLine, mode });
    }
    if (!entries.length) continue;
    entries.sort((a, b) => (a.file === b.file ? a.startLine - b.startLine : a.file.localeCompare(b.file)));
    (usageByVar[v.name] || (usageByVar[v.name] = [])).push(...entries);
  }

  // --- «Связи»: whole-project function-relations graph, for the VS Code
  // extension's per-function "Связи" panel (interactive caller/callee chain
  // walking — see renderRelations below). Built from the exact same
  // funcs/varDefs/peripherals this whole scan already produced, so it's
  // free to compute here rather than a second project-wide parse.
  const relations = buildRelationsGraph(funcs, varDefs, peripherals);

  return {
    svgs: level0.svgs,
    nodeInfo,
    usageByVar,
    relations,
    varsToggle: level0.varsToggle,
    cyclicToggle: level0.cyclicToggle,
    dmaToggle: level0.dmaToggle,
    note: level0.note,
  };
}

// ---------------------------------------------------------------------------
// «Связи»: whole-project function-relations graph + interactive dot
// re-render — a VS Code-side port of the CLI's per-function "Связи" page
// (index.mjs's graph-data.js generation + viewer.js's setupRelationsDiagram).
// Unlike the CLI, which loads graphviz-wasm.js *in the browser* to re-lay-out
// the chain the user is expanding, this extension renders exclusively on the
// host (same Node graphviz-wasm this whole file already uses for level0) and
// ships the webview a finished SVG per click — consistent with how every
// other diagram in this extension works, and avoiding a second WASM runtime
// inside the webview's CSP-locked context. Scoped down from the CLI version
// on purpose (user decision 2026-07-20): dot only, no neato/fdp engine
// switch and no position-pinning (both neato-only concerns there) — the
// in-rank *order* stability fix (topoOrder/lastOrder below) is dot's own
// answer to the same "don't let it jump around on every click" problem.
// ---------------------------------------------------------------------------

const extId = name => 'x_' + sanitize(name);

// Every function in the project (not just entry/ISR — level 0's nodeInfo
// above deliberately skips plain functions, but "Связи" is exactly about
// walking into them), plus every var/peripheral, in the same id namespace
// (fnId/varId/periphId) everything else here uses. Mirrors index.mjs's own
// graph-data.js generation (window.GRAPH.nodes) closely on purpose — same
// shape, so the dot-emission helpers below could be ported near-verbatim
// from viewer.js's client-side versions.
function buildRelationsGraph(funcs, varDefs, peripherals) {
  const G = {};
  for (const fn of funcs.values()) {
    G[fnId(fn.key)] = {
      kind: fn.isISR ? 'isr' : fn.isEntry ? 'entry' : 'fn',
      label: fn.name, file: fn.file, filePath: fn.filePath, startLine: fn.startLine,
      desc: fn.desc || undefined,
      calls: [...fn.calls].map(fnId),
      callers: [...fn.callers].map(fnId),
      access: [...fn.access.entries()].map(([vk, mode]) => ({ v: varId(vk), mode })),
      periph: fn.periphFields.size
        ? [...fn.periphFields.keys()].map(name => ({
            id: periphId(name), name,
            regs: [...fn.periphFields.get(name).entries()].map(([reg, mode]) => {
              const flags = fn.periphFlags.get(name)?.get(reg);
              return {
                reg, mode,
                rFlags: flags && flags.r.size ? [...flags.r] : undefined,
                wFlags: flags && flags.w.size ? [...flags.w] : undefined,
              };
            }),
          }))
        : undefined,
    };
    for (const ec of fn.extCalls) {
      G[extId(ec)] = G[extId(ec)] || { kind: 'extfn', label: ec };
    }
  }
  for (const v of varDefs.values()) {
    G[varId(v.key)] = {
      kind: v.isExternal ? 'extvar' : v.isVolatile ? 'gvolatile' : 'gvar',
      label: v.name, file: v.file || undefined, type: v.typeText || undefined,
      static: v.isStatic || undefined,
    };
  }
  for (const p of peripherals.values()) {
    G[periphId(p.name)] = { kind: 'periph', label: p.name };
  }
  return G;
}

// Resolves a (name, file-basename) pair — everything the "Алгоритмы" ribbon
// knows about the function the user clicked — to its id in G. A linear scan
// (not a name->id index) is fine here: G tops out at a few hundred entries
// for any real embedded project, and this only runs once per click on a
// function name, not per frame.
// `file` is only a disambiguation hint, not a requirement: the "Показать
// «Связи»" button on a right-clicked call token (main.js's showOtherPlaces)
// has no reliable definition-file for its target — the call may well be to a
// function defined in some other .c/.h entirely — so a same-name match
// anywhere in the project is accepted too (first one found; two same-named
// functions in different files is rare enough in an embedded project that
// picking either is a reasonable fallback, not a bug to guard against).
export function resolveFunctionId(G, name, file) {
  let anyMatch = null;
  for (const [id, info] of Object.entries(G)) {
    if (!(info.kind === 'fn' || info.kind === 'entry' || info.kind === 'isr') || info.label !== name) continue;
    if (info.file === file) return id;
    if (!anyMatch) anyMatch = id;
  }
  return anyMatch;
}

// --- dot emission (ported near-verbatim from viewer.js's client-side
// versions — pure string building, nothing DOM-specific about them) --------

const relTrunc = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
const RELKIND = { isr: 'ISR', entry: 'main', fn: 'func' };

function relFnNodeLine(id, info, sameFile) {
  const rows = [dotKindRow(RELKIND[info.kind] || 'func'), `<B>${dotEsc(info.label)}</B>`];
  if (info.file && !sameFile) rows.push(`<FONT POINT-SIZE="9">${dotEsc(info.file)}</FONT>`);
  if (info.desc) rows.push(`<FONT POINT-SIZE="9"><I>${dotEsc(relTrunc(info.desc, 46))}</I></FONT>`);
  return dotNode(id, rows, 'box', info.kind);
}
function relVarNodeLine(id, info, sameFile) {
  const kindLabel = info.kind === 'extvar' ? 'ext var' : info.kind === 'gvolatile' ? 'volatile' : 'var';
  const cls = info.kind === 'extvar' ? 'ghost' : 'gvar';
  const nameColor = info.kind === 'gvolatile' ? ' COLOR="#dc2626"' : '';
  const rows = [dotKindRow(kindLabel), `<B${nameColor}>${dotEsc(info.label)}</B>`];
  const sub = [];
  if (info.type) sub.push(dotEsc(info.type));
  if (info.static) sub.push('static');
  if (info.file && !sameFile) sub.push(dotEsc(info.file));
  if (sub.length) rows.push(`<FONT POINT-SIZE="9">${sub.join(' &#183; ')}</FONT>`);
  return dotNode(id, rows, 'cylinder', cls);
}
// peripheral block on a function's "Связи" diagram — kept compact (just the
// name); the specific registers/bits this function touches go on the edge
// instead (see relPeriphDirDetail), same split dotPeriphNode/dotPeriphAccessEdges
// use for the level-0 diagram.
function relPeriphNodeLine(id, name) {
  const rows = [dotKindRow('периферия'), `<B>${dotEsc(name)}</B>`];
  return dotNode(id, rows, 'hexagon', 'periph');
}
// mirrors dotPeriphAccessEdges's own isEnableFlagName/shortFlagName exactly.
const REL_ENABLE_FLAG_RE = /(?:EN|ON|UE)$/;
function relIsEnableFlagName(name) { return REL_ENABLE_FLAG_RE.test(name); }
function relShortFlagName(flagName) {
  const idx = flagName.indexOf('_');
  return idx === -1 ? flagName : flagName.slice(idx + 1);
}
// one direction's full register/bit breakdown, revealed on hover via
// injectPeriphDetailLabels — mirrors periphDirDetail (level-0's own version)
// against this function's `regs` array instead of a fields/flags Map pair.
function relPeriphDirDetail(regs, dir, cap = 6) {
  const relevant = regs.filter(r => r.mode.includes(dir));
  if (!relevant.length) return { detail: '', hasEnable: false, enableLabel: '', readLabel: '' };
  let hasEnable = false, enableLabel = '';
  const sorted = [...relevant].sort((a, b) => a.reg.localeCompare(b.reg));
  const names = sorted.map(r => {
    if (dir === 'w') {
      const flags = r.wFlags;
      if (!flags || !flags.length) return r.reg;
      const sortedFlags = [...flags].sort((a, b) => a[0].localeCompare(b[0]));
      if (!hasEnable) {
        const enableBit = sortedFlags.find(([fl, pol]) => relIsEnableFlagName(fl) && pol !== 'clear');
        if (enableBit) { hasEnable = true; enableLabel = relShortFlagName(enableBit[0]); }
      }
      return sortedFlags.map(([fl, pol]) => {
        const short = relShortFlagName(fl);
        return pol === 'both' ? `~${short}, ${short}` : (pol === 'clear' ? '~' : '') + short;
      }).join(', ');
    }
    const flags = r.rFlags;
    if (flags && flags.length) return [...flags].sort().map(relShortFlagName).join(', ');
    return r.reg;
  });
  const shown = names.slice(0, cap);
  if (names.length > cap) shown.push(`+${names.length - cap}`);
  // See periphDirDetail's own comment (level0's version) — read's analogue
  // of the write side's enable-bit hint: a single specific flag being
  // tested is worth showing at rest instead of only on hover.
  let readLabel = '';
  if (dir === 'r' && relevant.length === 1 && relevant[0].rFlags && relevant[0].rFlags.length === 1) {
    readLabel = relShortFlagName(relevant[0].rFlags[0]);
  }
  return { detail: shown.join('\\n'), hasEnable, enableLabel, readLabel };
}
const relCallEdge = (callerId, calleeId) => dotEdge(callerId, calleeId, { style: 'dashed' });
// always 0-2 separate directed lines (never dir=both) — a register/var both
// read and written gets its own write edge and read edge, each with its own
// label, instead of one double-headed arrow (see bendAntiParallelEdges for
// how the resulting coincident write/read lines get visually told apart).
// constraint=false on both: a var/periph's rank is already fully decided by
// buildRelationsDot's own explicit {rank=same} groups + backbone chain, and
// an 'rw' access draws edges in *both* directions between the same two nodes
// — a direct rank cycle dot has to break somehow if left as a normal ranking
// constraint, and depending on which side it picks to reverse, that could
// visibly shuffle unrelated functions' rank order too (user report
// 2026-07-21: "переменные... перевешивают"). Letting access edges influence
// ranking at all was never needed — only real call edges (relCallEdge) and
// our own explicit rank assignment should ever decide function order.
function relAccessEdge(fnIdStr, otherIdStr, mode, wLabel = '', rLabel = '', dashedRead = false, wId, rId) {
  const lines = [];
  if (mode.includes('w')) {
    lines.push(dotEdge(fnIdStr, otherIdStr, { label: wLabel || undefined, id: wId, constraint: false }));
  }
  if (mode.includes('r')) {
    lines.push(dotEdge(otherIdStr, fnIdStr, { label: rLabel || undefined, style: dashedRead ? 'dashed' : undefined, id: rId, constraint: false }));
  }
  return lines;
}

// Stable order for one rank's nodes (dot's own in-rank order otherwise
// reshuffles on any click that adds a cross-link — see buildRelationsDot):
// respects every real edge between two rank-mates, and among nodes free of
// such constraints, prefers preferredOrder (kept-from-last-render nodes
// first, in their old sequence, then newly-added ones). Verbatim port of
// viewer.js's topoOrder.
function topoOrder(ids, precedenceEdges, preferredOrder) {
  const prefIndex = new Map(preferredOrder.map((id, i) => [id, i]));
  const idsSet = new Set(ids);
  const adj = new Map(ids.map(id => [id, []]));
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const [f, t] of precedenceEdges) {
    if (!idsSet.has(f) || !idsSet.has(t) || f === t) continue;
    adj.get(f).push(t);
    indeg.set(t, indeg.get(t) + 1);
  }
  const cmp = (a, b) => {
    const pa = prefIndex.has(a) ? prefIndex.get(a) : Infinity;
    const pb = prefIndex.has(b) ? prefIndex.get(b) : Infinity;
    return pa !== pb ? pa - pb : ids.indexOf(a) - ids.indexOf(b);
  };
  const ready = ids.filter(id => indeg.get(id) === 0).sort(cmp);
  const result = [], done = new Set();
  while (ready.length) {
    ready.sort(cmp);
    const id = ready.shift();
    result.push(id);
    done.add(id);
    for (const nb of adj.get(id)) {
      indeg.set(nb, indeg.get(nb) - 1);
      if (indeg.get(nb) === 0 && !done.has(nb)) ready.push(nb);
    }
  }
  for (const id of ids) if (!done.has(id)) result.push(id); // cycle leftovers
  return result;
}

// Builds the dot lines for "everything that should currently be visible":
// focus, its variables/peripherals, every already-chosen link in
// upPath/downPath, and — for each of those two chains — one more level (the
// "frontier": candidates not yet narrowed down, shown at full color since
// nothing there has been picked between). Dot-only port of viewer.js's
// buildDot — no pos="x,y!" pinning (neato-only, dropped per user decision
// 2026-07-20), but keeps its in-rank order-stability pass (rankOf/topoOrder
// below): dot's own crossing-minimization otherwise re-decides top-to-bottom
// order within a rank on every render, which reads as the diagram jumping
// around on each click even though the rank structure itself never changes.
function buildRelationsDot(G, { focusId, upPath, downPath, showVars, prevOrder }) {
  const nodeLines = [];
  const edgeLines = [];
  const edgeKeys = new Set(); // "from>to" already drawn (walk below, or the cross-link pass at the end)
  const seenNodes = new Set();
  const fullColor = new Set([focusId]);
  const depthOf = new Map(); // id -> { side: 'up'|'down', depth }
  const focusFile = G[focusId].file;
  const edgeDetails = []; // {from, to, detail} — see injectPeriphDetailLabels

  const edgePairs = []; // real call edges — precedence constraints for topoOrder
  // id -> { mode: 'r'|'w'|'rw', ownerRank }: rank is relative to whichever
  // function actually accesses it (ownerRank), not always focus — a var/
  // periph belonging to a drilled-into callee (functionRankOf(fid) !== 0)
  // must land one column further out from THAT function's own rank, or it
  // collides with the callee's own rank-mates (the exact bug in the DMA
  // report below). First accessor wins on a shared var/periph (rare, and
  // focus's own access — added first — is the most relevant placement when
  // it applies at all).
  const varPeriphMode = new Map();

  function ensureFn(id) {
    if (seenNodes.has(id) || !G[id]) return;
    seenNodes.add(id);
    nodeLines.push(relFnNodeLine(id, G[id], G[id].file === focusFile));
  }
  function addCallEdge(from, to) {
    const ek = from + '>' + to;
    if (edgeKeys.has(ek)) return;
    edgeKeys.add(ek);
    edgeLines.push(relCallEdge(from, to));
    edgePairs.push([from, to]);
  }
  // depthOf is only fully populated once walk() below has run — fine here
  // since every caller of this either passes focusId (short-circuits before
  // touching depthOf) or runs after walk() (every upPath/downPath member).
  function functionRankOf(fid) {
    if (fid === focusId) return 0;
    const d = depthOf.get(fid);
    return d ? (d.side === 'up' ? -(d.depth + 1) : (d.depth + 1)) : 0;
  }
  function addVarsOf(fid) {
    if (!showVars) return;
    const ownerRank = functionRankOf(fid);
    for (const a of (G[fid].access || [])) {
      if (!seenNodes.has(a.v) && G[a.v]) {
        seenNodes.add(a.v);
        nodeLines.push(relVarNodeLine(a.v, G[a.v], G[a.v].file === focusFile));
      }
      edgeLines.push(...relAccessEdge(fid, a.v, a.mode));
      fullColor.add(a.v);
      if (!varPeriphMode.has(a.v)) varPeriphMode.set(a.v, { mode: a.mode, ownerRank });
    }
  }
  // Unlike addVarsOf, not gated on showVars: level0's own diagram always
  // shows peripherals regardless of its "переменные" checkbox (only global
  // vars are behind that toggle there — see buildLevel0Diagram's nodeLines
  // vs. varNodeLines split), so "Связи" hiding periph writes/reads whenever
  // vars were off (user report 2026-07-21) was an inconsistency, not by design.
  function addPeriphOf(fid) {
    const ownerRank = functionRankOf(fid);
    for (const pa of (G[fid].periph || [])) {
      if (!seenNodes.has(pa.id)) {
        seenNodes.add(pa.id);
        nodeLines.push(relPeriphNodeLine(pa.id, pa.name));
      }
      const w = relPeriphDirDetail(pa.regs, 'w');
      const r = relPeriphDirDetail(pa.regs, 'r');
      const mode = (r.detail ? 'r' : '') + (w.detail ? 'w' : '');
      const wDefault = pa.name === 'RCC' ? '' : (w.hasEnable ? w.enableLabel : '');
      const wLabel = w.detail ? (wDefault || ' ') : wDefault;
      const rLabel = r.detail ? (r.readLabel || ' ') : '';
      // ids matching dotPeriphAccessEdges's own pe_<from>_<to>_<dir> scheme —
      // fid is already part of the id, so two different functions touching
      // the same peripheral (focus and a drilled-into callee, say) still get
      // distinct, collision-free ids without any extra prefix. Without a
      // matching id at all, injectPeriphDetailLabels below has nothing to
      // splice the full register/bit breakdown into, so multi-register or
      // non-enable-bit writes rendered as a blank arrow with no way to see
      // what was actually written (user report 2026-07-21).
      const wId = w.detail ? `pe_${fid}_${pa.id}_w` : undefined;
      const rId = r.detail ? `pe_${pa.id}_${fid}_r` : undefined;
      edgeLines.push(...relAccessEdge(fid, pa.id, mode, wLabel, rLabel, true, wId, rId));
      if (w.detail) edgeDetails.push({ id: wId, detail: w.detail });
      if (r.detail) edgeDetails.push({ id: rId, detail: r.detail });
      fullColor.add(pa.id);
      if (!varPeriphMode.has(pa.id)) varPeriphMode.set(pa.id, { mode, ownerRank });
    }
  }

  ensureFn(focusId);
  addVarsOf(focusId);
  addPeriphOf(focusId);

  function walk(side, path, adjKey, dirOf) {
    let prev = focusId;
    for (let i = 0; i < path.length; i++) {
      for (const s of (G[prev][adjKey] || [])) {
        ensureFn(s);
        const [from, to] = dirOf(s, prev);
        addCallEdge(from, to);
        if (!depthOf.has(s)) depthOf.set(s, { side, depth: i });
      }
      prev = path[i];
    }
    for (const s of (G[prev][adjKey] || [])) {
      ensureFn(s);
      const [from, to] = dirOf(s, prev);
      addCallEdge(from, to);
      fullColor.add(s);
      if (!depthOf.has(s)) depthOf.set(s, { side, depth: path.length });
    }
    for (const p of path) fullColor.add(p);
  }
  walk('up', upPath, 'callers', (s, prev) => [s, prev]);
  walk('down', downPath, 'calls', (s, prev) => [prev, s]);

  // Every function already drilled into (not just the original focus) shows
  // its own variable/peripheral access too — walk() above only draws the
  // *call* edges along upPath/downPath, so a callee's own register writes
  // (e.g. drilling into a "kick the DMA" helper) stayed invisible even once
  // it was the very node on screen (user report 2026-07-21: no arrow from a
  // callee to the peripheral it obviously touches). Deliberately NOT applied
  // to the one-more-level frontier walk() also draws (candidates not yet
  // picked) — that would clutter every unexplored branch with detail nobody
  // asked to see yet; only the confirmed chain earns it.
  for (const id of [...upPath, ...downPath]) {
    addVarsOf(id);
    addPeriphOf(id);
  }

  // Connect any two nodes that are *both* already on screen, even when
  // neither is on the currently-drilled path — e.g. two sibling callees that
  // happen to call each other.
  for (const id of seenNodes) {
    const info = G[id];
    if (!info || !Array.isArray(info.calls)) continue; // skip var/periph nodes
    for (const c of info.calls) {
      if (seenNodes.has(c)) addCallEdge(id, c);
    }
  }

  // Force each node's rank explicitly from depthOf/varPeriphMode (never from
  // dot's own longest-path computation, which a fresh cross-link could
  // otherwise shift on any click) and re-assert the previous in-rank order
  // via invisible edges.
  const orderLines = [];
  const rankOf = id => {
    if (id === focusId) return 0;
    const d = depthOf.get(id);
    if (d) return d.side === 'up' ? -(d.depth + 1) : (d.depth + 1);
    const vp = varPeriphMode.get(id);
    // Relative to whichever function actually owns this access (ownerRank),
    // not always focus — a var/periph belonging to a drilled-into callee
    // must land one column further out from THAT function's rank, or it
    // collides with the callee's own rank-mates (e.g. a callee's DMA target
    // ending up sharing a rank — and so a column — with the callee itself,
    // user report 2026-07-21).
    return vp ? vp.ownerRank + (vp.mode.includes('w') ? 1 : -1) : null;
  };
  const groups = new Map(); // rank -> [ids]
  for (const id of seenNodes) {
    const rk = rankOf(id);
    if (rk === null || rk === 0) continue;
    if (!groups.has(rk)) groups.set(rk, []);
    groups.get(rk).push(id);
  }
  const newOrder = new Map();
  for (const [rk, ids] of groups) {
    const idsSet = new Set(ids);
    const precedence = edgePairs.filter(([f, t]) => idsSet.has(f) && idsSet.has(t));
    const prev = (prevOrder && prevOrder.get(rk)) || [];
    const kept = prev.filter(id => idsSet.has(id));
    const fresh = ids.filter(id => !kept.includes(id));
    const order = topoOrder(ids, precedence, [...kept, ...fresh]);
    newOrder.set(rk, order);
    orderLines.push(`  { rank=same; ${order.join('; ')}; }`);
    for (let i = 0; i < order.length - 1; i++) {
      orderLines.push(`  ${order[i]} -> ${order[i + 1]} [style=invis, weight=100];`);
    }
  }

  // Chain every present rank level together via a high-weight invisible
  // "backbone" edge (one representative node per rank), regardless of
  // integer gaps between them. {rank=same} above only forces nodes *within*
  // one level to share a rank — which level comes before/after another is
  // still decided by dot's own longest-path computation over every real
  // edge, so a variable's read/write link (rank = ownerRank ± 1, same as any
  // other edge to dot) could shift where a whole function's rank landed,
  // visibly reordering functions whenever a var happened to appear on one
  // (user report 2026-07-21: "переменные... перевешивают"). This backbone's
  // weight (1000) dwarfs every real edge's (call edges are unweighted = 1,
  // in-rank order above is 100), so function-to-function call structure is
  // the only thing that can ever decide relative function order again.
  const allRanks = [...groups.keys(), 0].sort((a, b) => a - b);
  const repOf = rk => (rk === 0 ? focusId : newOrder.get(rk)[0]);
  for (let i = 0; i < allRanks.length - 1; i++) {
    orderLines.push(`  ${repOf(allRanks[i])} -> ${repOf(allRanks[i + 1])} [style=invis, weight=1000];`);
  }

  return { nodeLines, edgeLines, orderLines, fullColor, depthOf, edgeDetails, newOrder, seenNodes };
}

// Renders one "Связи" click's worth of state to a finished SVG — always on
// the host (see the section header above for why): the extension-host
// equivalent of viewer.js's render(), dot engine only. `prevOrder` is the
// previous call's returned `newOrder` (a Map), threaded through by the
// caller (extension.js keeps it in its per-panel relState) so in-rank order
// stays stable across clicks; pass null/undefined on the very first render.
export async function renderRelations({ G, focusId, upPath = [], downPath = [], showVars = true, prevOrder = null }) {
  if (!G[focusId]) throw new Error('renderRelations: unknown focusId');
  const { nodeLines, edgeLines, orderLines, fullColor, depthOf, edgeDetails, newOrder, seenNodes } =
    buildRelationsDot(G, { focusId, upPath, downPath, showVars, prevOrder });
  const dotText = [
    'digraph G {',
    '  graph [fontname="Segoe UI, Helvetica, sans-serif", nodesep=0.35, bgcolor=transparent, rankdir=LR, ranksep=0.6];',
    '  node [fontname="Segoe UI, Helvetica, sans-serif", style=filled, fillcolor=white];',
    '  edge [fontname="Segoe UI, Helvetica, sans-serif", fontsize=10];',
    ...nodeLines, ...edgeLines, ...orderLines, '}',
  ].join('\n');
  const rawSvg = getGraphviz().layout(dotText, 'svg', 'dot');
  const svg = stripXmlProlog(injectPeriphDetailLabels(bendAntiParallelEdges(rawSvg), edgeDetails));
  // Tooltip/navigate data for only the nodes actually drawn this render —
  // not the whole (project-wide) G, which would otherwise get re-sent to
  // the webview on every single click.
  const nodeInfo = {};
  for (const id of seenNodes) {
    const info = G[id];
    if (!info) continue;
    nodeInfo[id] = {
      kind: info.kind, label: info.label, file: info.file, filePath: info.filePath,
      startLine: info.startLine, desc: info.desc, type: info.type, static: info.static,
    };
  }
  return { svg, fullColor, depthOf, newOrder, nodeInfo };
}

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

// Classifies a call_expression's own `function` node: a plain name
// (`foo()`) resolves directly against the project's real functions later,
// same as before — but `obj->cb()` / `obj.cb()` (field_expression),
// `table[i]()` (subscript_expression) and `(*fp)()` (a dereferenced
// pointer) never have, and *specifically because they're indirect never
// will have, a plain identifier to look up: the call graph used to just
// drop these on the floor. No type information is tracked anywhere in this
// analyzer, so there's no way to know *which* struct/array a given
// `->field`/`[i]` targets — the same "key by name alone, union every
// project-wide match" trade-off already made for periph/DMA resolution
// (resolveAddrExpr) applies here too: an indirect call's target is
// resolved by matching its field/variable name against every assignment of
// that same name anywhere in the project (collectFpAssignments + the
// fpTargets map built during the main scan), not by tracing the actual
// pointer's type.
function resolveCallTarget(fnNode) {
  let n = fnNode;
  while (n && n.type === 'parenthesized_expression') n = n.namedChildren[0];
  if (n && n.type === 'pointer_expression' && n.childForFieldName('operator')?.text === '*') {
    n = n.childForFieldName('argument');
    while (n && n.type === 'parenthesized_expression') n = n.namedChildren[0];
  }
  if (!n) return null;
  if (n.type === 'identifier') return { kind: 'direct', name: n.text };
  if (n.type === 'field_expression') {
    const field = n.childForFieldName('field')?.text;
    return field ? { kind: 'indirect', key: field } : null;
  }
  if (n.type === 'subscript_expression') {
    let base = n.childForFieldName('argument');
    while (base && base.type === 'parenthesized_expression') base = base.namedChildren[0];
    return base && base.type === 'identifier' ? { kind: 'indirect', key: base.text } : null;
  }
  return null;
}

// Every "name (whether a plain variable, or the last field of a `.`/`->`
// access) was assigned a real function's name" fact in one file — the raw
// material for fpTargets (built project-wide once functionsByName exists to
// filter these down to real functions). Deliberately walks the *whole* file
// (translation_unit), not just function bodies: the classic C pattern this
// exists for — `static const Ops my_ops = { .read = my_read, ... };` —
// lives at file scope, outside any function. No type tracking here either,
// same as resolveCallTarget: `key` is just the bare variable/field name, so
// `X.read = a;` and `Y.read = b;` for two unrelated struct types both feed
// the same `read` bucket — an accepted false-positive risk, not a bug (same
// trade-off as periph resolution elsewhere).
function collectFpAssignments(root) {
  const out = [];
  walkTree(root, n => {
    if (n.type === 'assignment_expression') {
      if (n.childForFieldName('operator')?.text !== '=') return;
      const right = n.childForFieldName('right');
      if (!right || right.type !== 'identifier') return;
      let left = n.childForFieldName('left');
      if (!left) return;
      // `table[2] = target;` — peel `[index]` layers the same way
      // resolveCallTarget does for the read side (`table[i]()`), so the two
      // sides agree on the same base-name key.
      while (left && left.type === 'subscript_expression') left = left.childForFieldName('argument');
      while (left && left.type === 'parenthesized_expression') left = left.namedChildren[0];
      if (!left) return;
      if (left.type === 'identifier') out.push({ key: left.text, valueName: right.text });
      else if (left.type === 'field_expression') {
        const field = left.childForFieldName('field')?.text;
        if (field) out.push({ key: field, valueName: right.text });
      }
      return;
    }
    if (n.type === 'init_declarator') {
      const value = n.childForFieldName('value');
      if (value && value.type === 'identifier') {
        const nm = findNameInDeclarator(n.childForFieldName('declarator'));
        if (nm) out.push({ key: nm, valueName: value.text });
      }
      return;
    }
    if (n.type === 'initializer_pair') {
      // `{ .read = my_read, .write = my_write }` — the callback-table
      // pattern. Only the single-level `.field = value` shape is handled
      // (childForFieldName only ever returns the *first* designator, so a
      // nested `.a.b = x`/`.arr[2].field = x` designator falls through
      // unmatched below rather than being misread) — good enough for the
      // common case without pretending to parse the general one.
      const value = n.childForFieldName('value');
      if (!value || value.type !== 'identifier') return;
      const designator = n.childForFieldName('designator');
      if (designator && designator.type === 'field_designator') {
        const fieldIdent = designator.namedChildren.find(c => c.type === 'field_identifier');
        if (fieldIdent) out.push({ key: fieldIdent.text, valueName: value.text });
      }
    }
  });
  return out;
}

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
    .replace(/^[@\\]fn\s+\S+\s*/i, '')
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
// fold a new access mode into an existing one: r + w (in either order) => rw.
const mergeMode = (prev, m) => (!prev ? m : prev === m ? prev : 'rw');

// CMSIS/HAL bit-flag macros are always SHOUTING_SNAKE_CASE — a local
// variable or parameter is not (`byte`, `data`, `len`). Used to keep
// collectIdentifiers from misattributing a plain data value as a "flag" once
// flag extraction covers plain `=` assignments too (see analyzeFunction's
// third addFlagNames branch below) — `USART1->DR = byte` must never grow a
// fake "byte" flag entry the way `CCR = DMA_CCR_MINC | DMA_CCR_EN` correctly
// grows `MINC`/`EN` ones.
const MACRO_CONST_RE = /^[A-Z_][A-Z0-9_]*$/;
// every named identifier leaf under a (possibly grouped/OR'd) expression,
// e.g. collectIdentifiers for `(FLAG1 | FLAG2)` -> {FLAG1, FLAG2} — used to
// pull every flag name out of a bitmask test regardless of how many bits it
// checks at once. Only collects SHOUTING_SNAKE_CASE leaves (see
// MACRO_CONST_RE) — a lowercase identifier is a variable, never a flag.
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
// re-armed in the same function, e.g. u1_kick's `CCR &= ~DMA_CCR_EN; ...;
// CCR |= DMA_CCR_EN;`) collapses to 'both' rather than picking one arbitrarily
// — periphDirDetail treats 'both' as "ends up enabled", same as a plain 'set'.
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

// Bare DMA controller instance (DMA1, DMA2 — never DMA1_Channel4, that's its
// own instance). Declared up here, ahead of fileRecords/peripherals below,
// because analyzeFunction (which needs it) runs while fileRecords is still
// being built. See the fuller comment by allDerefNames/dmaChannelTarget.
const DMA_BUS_RE = /^DMA[0-9]+$/;

function analyzeFunction(funcNode) {
  const declarator = funcNode.childForFieldName('declarator');
  const locals = new Set();
  // a local pointer's own initializer, resolved one level deep — see
  // resolveLocalAlias — so `X->CMAR = m->data` can be traced through
  // `U1Msg *m = &u1_q[u1_q_tail];` back to `u1_q`, the same way a direct
  // `X->CMAR = u1_rx_buf` already resolves. name -> {kind, name/key, field}
  // Orthogonal to resolveSymbolicRef below (this is CPAR/CMAR's OWN "what
  // does this pointer ultimately point at, var or periph" question, not
  // periph-base resolution) — kept as its own separate mechanism.
  const localAliases = new Map();
  // This function's own local array literals (`T *const PORTS[] = {...};`)
  // and locals resolved to a peripheral candidate set via resolveSymbolicRef
  // (`GPIO_TypeDef *p = port_reg(...);` or `= PORTS[i];`) — both feed the
  // `scope` resolveSymbolicRef needs for everything below. Built in
  // declaration order in the SAME walk, so a local may reference an EARLIER
  // one (never a later one — matches normal C declare-before-use).
  const localArrays = new Map();
  const localPeriphVars = new Map();
  const scope = { locals, localArrays, localVars: localPeriphVars };
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
            if (value && value.type === 'initializer_list' && value.namedChildren.length
                && value.namedChildren.every((it) => it.type === 'identifier' && MACRO_CONST_RE.test(it.text))) {
              localArrays.set(nm, new Set(value.namedChildren.map((it) => it.text)));
            } else if (value) {
              const resolved = resolveSymbolicRef(value, scope);
              if (resolved.size) localPeriphVars.set(nm, resolved);
            }
          }
        }
      }
    });
  }

  const calls = new Set();
  const indirectCalls = new Set(); // field/subscript/deref call-target keys — see resolveCallTarget
  // raw first-argument text of calls that arm an NVIC interrupt line, e.g.
  // "DMA1_Channel2_IRQn" from NVIC_EnableIRQ(DMA1_Channel2_IRQn)
  const armCalls = new Set();
  // identifiers used as the base of an arrow access (`X->field`) and never
  // otherwise declared in the scanned sources — the CMSIS/HAL convention for
  // a peripheral register block (`#define DMA1_Channel2 ((...*)DMA1_Channel2_BASE)`
  // lives in a vendor header we don't parse, so these names never resolve to
  // a real variable; that absence is itself the signal that flags them as
  // peripheral candidates in pass 2, not a naming-convention guess
  const derefNames = new Set();
  // per-register breakdown behind each derefName: which fields of the block are
  // touched and how (`UART2->CR1 |= x` -> UART2: { CR1: 'rw' }). derefNames
  // still flags the block as a peripheral candidate in pass 2; this keeps the
  // field that pass used to throw away, so a reader of DR and a writer of CR1
  // on the same UART2 stay distinguishable.
  const derefFields = new Map(); // name -> Map(field -> 'r' | 'w' | 'rw')
  // named bits behind a register access, split by which mode they came in as
  // — read-tested (`if (X->SR & USART_SR_RXNE)`, how ISR bodies near-
  // universally spell "which interrupt source is this") vs write-set/cleared
  // (`X->CCR |= DMA_CCR_EN` / `X->CCR &= ~DMA_CCR_EN`) — a register touched
  // via two different bits in two different places should read as two
  // different things, not collapse to one anonymous "CCR: чтение/запись".
  // name -> Map(field -> { r: Set(flag name), w: Set(flag name) })
  const derefFlags = new Map();
  // a DMA channel's own address registers (`CPAR`/`CMAR`) resolved to
  // *what* they point at, when the right-hand side of a plain `X->CPAR = ...`
  // assignment is simple enough to tell statically — `&PERIPH->field` names a
  // peripheral, a bare identifier or `&identifier` names a global/static var.
  // Anything else (a local pointer alias, e.g. `X->CMAR = (uint32_t)m->data`
  // where `m` points into a runtime queue slot) is left unresolved — there's
  // no attempt to trace local pointer assignments. See resolveAddrExpr.
  // name -> Map(field -> { kind: 'var' | 'periph', name })
  const derefAddrRefs = new Map();
  const access = new Map(); // name -> { r, w }
  const NVIC_ARM_RE = /^(HAL_|LL_)?NVIC_EnableIRQ$/;
  // Records one `NAME->field` dereference — `p` is the `->` field_expression
  // itself. Shared by the direct case below (NAME is a bare identifier, the
  // common path — `p`'s own argument IS `n`) and the config-table-array case
  // (NAME is one of several candidates resolved from ARRAY_FIELD_PERIPHS,
  // `p`'s argument is a whole `ARR[i].field` chain instead — see that map's
  // own doc comment). Pulled out of the walkTree callback below so both
  // sites can call it without duplicating this logic.
  function recordDeref(name, field, p, mode) {
    derefNames.add(name);
    if (!field) return;
    // named bits behind this access, split by which mode they came in as —
    // 'r' from `X->field & FLAG` (either operand order, tests a bit), 'w'
    // from `X->field |= FLAG` (sets), `X->field &= ~FLAG` (clears), or a
    // plain `X->field = FLAG1 | FLAG2 | ...` (a one-shot full-register
    // config write). `w`'s per-flag value is a Map(flagName ->
    // 'set'|'clear'|'both'), not a Set — same flag name can mean opposite
    // things depending on whether it came in via `|=` (arm) or `&= ~`
    // (disarm); `r` stays a plain Set (a bit *test* has no set/clear
    // polarity). `polarity` is only meaningful when kind === 'w'.
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
    // `X->field |= FLAG` / `X->field &= ~FLAG` is the universal set/clear-a-
    // bit idiom (arm/disarm, enable/disable) — hardware-wise a read-modify-
    // write, but nothing is semantically *read* here: nobody downstream
    // branches on the bit this statement itself just set. Field-level mode
    // is downgraded to plain 'w' for exactly this idiom so it doesn't
    // masquerade as a read of the register.
    let fieldMode = mode;
    const parent = p.parent;
    const isSetClearIdiom = parent && parent.type === 'assignment_expression'
      && sameNode(parent.childForFieldName('left'), p)
      && (() => {
        const op = parent.children.find(c => !c.isNamed && c.text.endsWith('='))?.text;
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
      const op = parent.children.find(c => !c.isNamed && c.text.endsWith('='))?.text;
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
  // Records a periph access resolved not to one certain name but to a whole
  // candidate SET (anything resolveSymbolicRef returns more than one — or
  // even exactly one non-obvious — answer for). Pass 2 decides var-vs-
  // periph by walking fn.access's own keys, falling back to fn.derefNames
  // only for names it finds there — recordDeref alone (which only touches
  // derefNames/derefFields/derefFlags) leaves a candidate invisible to that
  // walk entirely unless it's ALSO in fn.access, same as the bottom-of-
  // callback update below does for every directly-visited identifier.
  function recordCandidates(candidates, field, p, mode) {
    for (const cand of candidates) {
      recordDeref(cand, field, p, mode);
      const cur = access.get(cand) || { r: false, w: false };
      if (mode.includes('r')) cur.r = true;
      if (mode.includes('w')) cur.w = true;
      access.set(cand, cur);
    }
  }
  if (body) {
    walkTree(body, n => {
      if (n.type === 'call_expression') {
        const target = resolveCallTarget(n.childForFieldName('function'));
        if (target && target.kind === 'direct') {
          calls.add(target.name);
          if (NVIC_ARM_RE.test(target.name)) {
            const args = n.childForFieldName('arguments');
            const first = args ? args.namedChildren[0] : null;
            if (first && first.type === 'identifier') armCalls.add(first.text);
          }
        } else if (target && target.kind === 'indirect') {
          indirectCalls.add(target.key);
        }
        return;
      }
      // Every `->` access, resolved through the SAME general chain
      // (resolveSymbolicRef) regardless of whether its base is a bare
      // peripheral name, a config-table array field, a helper-function
      // call, or a local variable holding any of the above — see that
      // function's own doc comment. Does NOT `return` afterward: walkTree
      // still descends into this field_expression's own children below
      // (the base expression's own identifiers, any nested `[index]`
      // subscripts, ...), each getting its ordinary access-tracking the
      // same as in any other expression.
      if (n.type === 'field_expression' && n.childForFieldName('operator')?.text === '->') {
        const candidates = resolveSymbolicRef(n.childForFieldName('argument'), scope);
        if (candidates.size) recordCandidates(candidates, n.childForFieldName('field')?.text, n, classifyAccess(n));
      }
      if (n.type !== 'identifier') return;
      const p = n.parent;
      if (p && p.type === 'call_expression' && sameNode(p.childForFieldName('function'), n)) return;
      if (p && p.type === 'field_expression' && sameNode(p.childForFieldName('field'), n)) return;
      // skip the *declared name* itself, but not initializer values / array sizes
      if (p && (p.type.endsWith('_declarator')) && sameNode(p.childForFieldName('declarator'), n)) return;
      const name = resolveMacroName(n.text);
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

  // Names directly called inside this function's own top-level infinite loop
  // (while(1)/for(;;) sitting as a direct statement of the body — not one
  // nested inside some other loop/helper). Used to tell apart "runs once at
  // boot" setup calls (main's clock/GPIO/peripheral init, all made *before*
  // this loop) from what actually recurs at runtime — see cyclicFuncKeys in
  // buildLevel0Diagram. Anywhere other than an entry point's own body this is
  // vestigial (a plain function's while loop doesn't make its own callees
  // "the runtime loop" — only entries seed cyclic-ness), but detecting it
  // unconditionally here is simpler than special-casing "is this main".
  const loopCallNames = new Set();
  const loopNode = findTopLevelInfiniteLoop(body);
  if (loopNode) {
    walkTree(loopNode, n => {
      if (n.type !== 'call_expression') return;
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'identifier') loopCallNames.add(fn.text);
    });
  }
  // hasLoop is distinct from "loopCallNames is non-empty": a real for(;;)/
  // while(1) whose body is just `__WFI();`/similar (sleep-until-interrupt,
  // nothing internal to call) still means "we found the actual runtime loop,
  // it just calls nothing worth tracking" — buildLevel0Diagram's cyclic seed
  // must trust that (seed with the empty set) rather than falling back to the
  // whole call tree, which is reserved for when no loop was found *at all*.
  const hasLoop = !!loopNode;

  return { calls, indirectCalls, armCalls, derefNames, derefFields, derefFlags, derefAddrRefs, access, signature, loopCallNames, hasLoop };
}

// Simple object-like `#define NAME OTHER_IDENT` peripheral/var aliases (e.g.
// STM32 code that names a UART's GPIO port `#define UART1_Prt GPIOB` because
// that's where its pins live) resolve to the SAME hardware block as whatever
// `OTHER_IDENT` itself resolves to — but this analyzer has no C preprocessor
// pass at all, so `UART1_Prt->CRL` and `GPIOB->CRL` used to name two
// different peripherals purely because they're spelled differently at the
// access site. Fixed with a light, best-effort pre-pass: collect every
// `#define NAME VALUE` project-wide where VALUE is *exactly* one bare
// identifier (never a function-like macro, never `((T*)0x...)` address
// casts — those define the REAL peripheral, not an alias of one, and must
// stay as themselves), then canonicalize through the chain at the same two
// points every periph/var base name is first read out of the AST
// (resolveAddrExpr below, and analyzeFunction's own `name` extraction) —
// every downstream consumer sees only the canonical name from there on.
// Module-level: rebuilt fresh at the top of every project scan from that
// scan's own files, read from deep inside analyzeFunction/resolveAddrExpr
// without threading a parameter through their whole call chain.
let MACRO_ALIASES = new Map();
const resolveMacroName = (name) => MACRO_ALIASES.get(name) || name;
// One file's `#define`s, raw (unchained) — walks the whole tree, not just
// top-level, so aliases guarded by `#ifdef` are still picked up (no macro
// is actually evaluated, so which #ifdef branch a define lives in is never
// checked — same best-effort trade-off already made for periph/DMA
// resolution elsewhere here).
function collectMacroAliases(root, out) {
  walkTree(root, (n) => {
    if (n.type !== 'preproc_def') return;
    const name = n.childForFieldName('name')?.text;
    const value = n.childForFieldName('value')?.text?.trim();
    if (name && value && /^[A-Za-z_]\w*$/.test(value)) out.set(name, value);
  });
}
// Chases each raw alias to whatever it ultimately names — `#define A B` +
// `#define B GPIOC` resolves `A` straight to `GPIOC`, not just one hop to
// `B`. Cycle-guarded (a chain that loops back on itself falls back to the
// last name seen before the repeat, rather than hanging).
function resolveMacroChains(raw) {
  const out = new Map();
  for (const start of raw.keys()) {
    const seen = new Set();
    let cur = start;
    while (raw.has(cur) && !seen.has(cur)) { seen.add(cur); cur = raw.get(cur); }
    if (cur !== start) out.set(start, cur);
  }
  return out;
}

// Config-table-driven peripheral access: `const PinConfig OUTPUT_PINS[N] =
// { {GPIOB, 0}, ... }; OUTPUT_PINS[i].port->BSRR = bit;` touches a real GPIO
// peripheral, but `->`'s own base here is `OUTPUT_PINS[i].port` — a whole
// subscript+field chain, not the bare identifier every other periph/var
// access in this analyzer requires — so it fell through completely
// unrecognized, silently missing from the diagram. `i` is a runtime index,
// so which exact element a given call touches can't be known statically;
// this resolves the field to the UNION of every literal SHOUTING_SNAKE_CASE
// value ever assigned to it across the array's own initializer instead —
// "touches ANY of these", not a precise per-call answer (explicitly
// accepted trade-off — the alternative is the access not appearing at all).
// ARRAY_FIELD_PERIPHS: arrayName -> Map(fieldName -> Set(candidate names));
// rebuilt fresh per project scan, same as MACRO_ALIASES right above.
let ARRAY_FIELD_PERIPHS = new Map();
// Same idea, one level simpler: a FLAT array (no struct/field involved) —
// `static GPIO_TypeDef *const PORTS[] = { GPIOA, GPIOB };` — where `arr[i]`
// alone (no trailing `.field`) names one of its own literal elements.
// arrayName -> Set(candidate names).
let ARRAY_ELEMENT_PERIPHS = new Map();
// A struct field's own declarator name — `GPIO_TypeDef *port;` wraps its
// `field_identifier` in a pointer_declarator, so this unwraps one layer the
// same way findNameInDeclarator does for ordinary variable declarators
// (which never see a field_identifier, hence its own separate helper here).
function fieldIdentifierName(declarator) {
  let d = declarator;
  while (d) {
    if (d.type === 'field_identifier') return d.text;
    d = d.childForFieldName('declarator');
  }
  return null;
}
// Struct field order (`typedef struct { A; B; } Name;` -> ['a','b']),
// needed to match a POSITIONAL array-of-struct initializer element
// (`{ GPIOA, 9 }`, no `.port =`/`.pin =` designators) back to field names.
function collectStructFieldOrders(root, out) {
  walkTree(root, (n) => {
    if (n.type !== 'type_definition') return;
    const typeNode = n.childForFieldName('type');
    const nameNode = n.childForFieldName('declarator');
    if (!typeNode || typeNode.type !== 'struct_specifier' || !nameNode) return;
    const body = typeNode.childForFieldName('body');
    if (!body) return;
    const fields = [];
    for (const fd of body.namedChildren) {
      if (fd.type !== 'field_declaration') continue;
      for (const d of childrenForField(fd, 'declarator')) {
        const fname = fieldIdentifierName(d);
        if (fname) fields.push(fname);
      }
    }
    if (fields.length) out.set(nameNode.text, fields);
  });
}
// One file's global array-of-known-struct declarations, each field's
// literal values collected into ARRAY_FIELD_PERIPHS (see its own doc
// comment above) whenever they look like SHOUTING_SNAKE_CASE peripheral
// names — every other kind of field value (numbers, expressions) is simply
// never added, so a field like `.pin` (plain integers) never produces a
// (harmless, just unused) entry at all.
function collectArrayFieldPeripherals(root, structFields, out) {
  walkTree(root, (n) => {
    if (n.type !== 'declaration' || insideFunction(n)) return;
    const typeNode = n.childForFieldName('type');
    const fieldOrder = typeNode && structFields.get(typeNode.text);
    if (!fieldOrder) return;
    for (const d of childrenForField(n, 'declarator')) {
      if (d.type !== 'init_declarator') continue;
      const arrDecl = d.childForFieldName('declarator');
      if (!arrDecl || arrDecl.type !== 'array_declarator') continue;
      const arrName = findNameInDeclarator(arrDecl);
      const initList = d.childForFieldName('value');
      if (!arrName || !initList || initList.type !== 'initializer_list') continue;
      let fieldMap = out.get(arrName);
      if (!fieldMap) { fieldMap = new Map(); out.set(arrName, fieldMap); }
      for (const elem of initList.namedChildren) {
        // each element is either `[IDX] = {...}` (initializer_pair) or a
        // bare `{...}` (plain positional array literal) — either way, what
        // we actually want is the {...} itself.
        const elemInit = elem.type === 'initializer_pair' ? elem.childForFieldName('value') : elem;
        if (!elemInit || elemInit.type !== 'initializer_list') continue;
        let pos = 0;
        for (const item of elemInit.namedChildren) {
          let fieldName, valueNode;
          if (item.type === 'initializer_pair') {
            const desig = item.childForFieldName('designator');
            const fid = desig && desig.type === 'field_designator' ? desig.namedChildren[0] : null;
            fieldName = fid && fid.text;
            valueNode = item.childForFieldName('value');
          } else {
            fieldName = fieldOrder[pos];
            valueNode = item;
            pos++;
          }
          if (!fieldName || !valueNode) continue;
          if (valueNode.type === 'identifier' && MACRO_CONST_RE.test(valueNode.text)) {
            if (!fieldMap.has(fieldName)) fieldMap.set(fieldName, new Set());
            fieldMap.get(fieldName).add(valueNode.text);
          }
        }
      }
    }
  });
}
// Flat (no struct) global array literal — `T *const PORTS[] = { GPIOA,
// GPIOB };` — feeds ARRAY_ELEMENT_PERIPHS (see its own doc comment). The
// declarator can be wrapped in an extra pointer_declarator ahead of the
// array_declarator (`T *const NAME[]` — the `*const` itself, not the array)
// so this unwraps however many layers separate the two, unlike
// collectArrayFieldPeripherals's array (always the OUTERMOST declarator
// there, since a struct-typed array is never itself behind a pointer).
function collectArrayElementPeripherals(root, out) {
  walkTree(root, (n) => {
    if (n.type !== 'declaration' || insideFunction(n)) return;
    for (const d of childrenForField(n, 'declarator')) {
      if (d.type !== 'init_declarator') continue;
      let ad = d.childForFieldName('declarator');
      while (ad && ad.type !== 'array_declarator') ad = ad.childForFieldName && ad.childForFieldName('declarator');
      if (!ad || ad.type !== 'array_declarator') continue;
      const arrName = findNameInDeclarator(d);
      const initList = d.childForFieldName('value');
      if (!arrName || !initList || initList.type !== 'initializer_list' || !initList.namedChildren.length) continue;
      const items = initList.namedChildren;
      if (!items.every((it) => it.type === 'identifier' && MACRO_CONST_RE.test(it.text))) continue;
      out.set(arrName, new Set(items.map((it) => it.text)));
    }
  });
}

// General symbolic-reference resolver — "which peripheral(s) could this
// expression evaluate to", by walking the SAME handful of primitives every
// indirection idiom seen so far turned out to be built from: a bare name
// (always its own answer, unless a known LOCAL resolution overrides it —
// the historical base case: any non-local identifier used as `->`'s base is
// assumed to name a peripheral, CMSIS's `((T*)BASE_ADDR)` convention, no
// naming-convention filter), a struct-array field's own static initializer
// (ARRAY_FIELD_PERIPHS), a flat array's own elements (ARRAY_ELEMENT_PERIPHS
// or the CALLER's own locally-declared array, via `scope.localArrays`), or
// a function call resolved through its own precomputed return-expression
// summary (FUNC_RETURN_PERIPHS) — chased recursively instead of hand-
// matching each shape's own exact AST pattern at its own call site. Always
// returns a Set (possibly empty — "no candidates" for anything genuinely
// computed, e.g. real pointer arithmetic, or a plain unresolved local,
// rather than a wrong guess).
// scope: { locals: Set(names) — this function's OWN local variables, never
//   themselves a project-wide peripheral unless localVars below says so;
//   localArrays: Map(name -> Set) — arrays declared INSIDE this function;
//   localVars: Map(name -> Set) — locals already resolved via this same
//   function, one assignment at a time, in declaration order (see
//   analyzeFunction) }. Omit entirely (undefined) when resolving outside
//   any function context (a global initializer, or a callee's own
//   return-summary computation using only ITS OWN locals).
function resolveSymbolicRef(node, scope) {
  let n = node;
  for (;;) {
    if (n && n.type === 'parenthesized_expression') { n = n.namedChildren[0]; continue; }
    if (n && n.type === 'cast_expression') { n = n.childForFieldName('value'); continue; }
    break;
  }
  if (!n) return new Set();
  if (n.type === 'identifier') {
    const name = resolveMacroName(n.text);
    if (scope && scope.localVars && scope.localVars.has(name)) return scope.localVars.get(name);
    if (scope && scope.locals && scope.locals.has(name)) return new Set(); // genuine unresolved local, never a global periph guess
    return new Set([name]);
  }
  if (n.type === 'field_expression') {
    if (n.childForFieldName('operator')?.text !== '.') return new Set();
    let base = n.childForFieldName('argument');
    while (base && base.type === 'parenthesized_expression') base = base.namedChildren[0];
    if (!base || base.type !== 'subscript_expression') return new Set();
    let arrBase = base.childForFieldName('argument');
    while (arrBase && arrBase.type === 'parenthesized_expression') arrBase = arrBase.namedChildren[0];
    if (!arrBase || arrBase.type !== 'identifier') return new Set();
    const field = n.childForFieldName('field')?.text;
    const fieldMap = ARRAY_FIELD_PERIPHS.get(arrBase.text);
    return (field && fieldMap && fieldMap.get(field)) || new Set();
  }
  if (n.type === 'subscript_expression') {
    let arrBase = n.childForFieldName('argument');
    while (arrBase && arrBase.type === 'parenthesized_expression') arrBase = arrBase.namedChildren[0];
    if (!arrBase || arrBase.type !== 'identifier') return new Set();
    return (scope && scope.localArrays && scope.localArrays.get(arrBase.text))
      || ARRAY_ELEMENT_PERIPHS.get(arrBase.text) || new Set();
  }
  if (n.type === 'call_expression') {
    const fnNode = n.childForFieldName('function');
    if (!fnNode || fnNode.type !== 'identifier') return new Set();
    return FUNC_RETURN_PERIPHS.get(fnNode.text) || new Set();
  }
  return new Set();
}
// A function's own local array literals (`T *const PORTS[] = {...};`
// declared INSIDE it) — the scaffolding resolveSymbolicRef needs to resolve
// a RETURN statement built on one, WITHOUT yet having that function's own
// full analyzeFunction scope (this runs in the project-wide pre-pass,
// before any function body is otherwise analyzed).
function collectLocalArrayLiterals(body) {
  const out = new Map();
  walkTree(body, (n) => {
    if (n.type !== 'declaration') return;
    for (const d of childrenForField(n, 'declarator')) {
      if (d.type !== 'init_declarator') continue;
      const nm = findNameInDeclarator(d);
      const value = d.childForFieldName('value');
      if (!nm || !value || value.type !== 'initializer_list' || !value.namedChildren.length) continue;
      const items = value.namedChildren;
      if (!items.every((it) => it.type === 'identifier' && MACRO_CONST_RE.test(it.text))) continue;
      out.set(nm, new Set(items.map((it) => it.text)));
    }
  });
  return out;
}
// A "peripheral-resolving helper" — one more hop of indirection past
// ARRAY_FIELD_PERIPHS/ARRAY_ELEMENT_PERIPHS: `static inline GPIO_TypeDef
// *port_reg(uint8_t port) { static GPIO_TypeDef *const PORTS[] = { GPIOA,
// GPIOB }; return PORTS[port]; }` wraps a PortId enum around the same
// "which peripheral" question those tables only used to answer directly.
// `port_reg(OUTPUT_PINS[i].port)->BSRR` (or the equivalent through a local
// — see analyzeFunction's own localPeriphVars) needs this resolved too.
// Driven by resolveSymbolicRef — not limited to the exact `return ARR[x];`
// shape, since anything that resolver can already chase (a direct `return
// GPIOA;`, `return ARR[x].field;`, even a call to ANOTHER such helper)
// resolves through the same recursive machinery. funcName -> Set(candidate
// names).
let FUNC_RETURN_PERIPHS = new Map();
function collectFuncReturnPeripherals(funcs, out) {
  for (const fn of funcs) {
    const body = fn.node.childForFieldName('body');
    if (!body) continue;
    const localArrays = collectLocalArrayLiterals(body);
    if (!localArrays.size) continue;
    const scope = { locals: new Set(), localArrays, localVars: new Map() };
    let found = null;
    walkTree(body, (n) => {
      if (found || n.type !== 'return_statement') return;
      const val = n.namedChildren[0];
      if (!val) return;
      const resolved = resolveSymbolicRef(val, scope);
      if (resolved.size) found = resolved;
    });
    if (found) out.set(fn.name, found);
  }
}
// Strips a DMA CPAR/CMAR assignment's right-hand side (or a local pointer's
// own initializer — see resolveLocalAlias) down to the expression that
// actually names the source/destination address — casts (`(uint32_t)...`)
// and parens first, then, if what's left is `&something`, unwraps that one
// layer too (both `X->CPAR = (uint32_t)&USART1->DR` and
// `X->CPAR = &USART1->DR` name the same target either way; a plain
// `X->CMAR = u1_rx_buf` never had a `&` in the first place — arrays decay to
// a pointer on their own), then unwraps one `[index]` layer the same way
// (`&u1_q[u1_q_tail]` names the array `u1_q`, whichever slot). What remains
// is classified: a field access (`->` or `.`) names whatever it's rooted at
// (`field` is kept too, for the hover-detail label — see dotDmaFlowEdge),
// unwrapping any `[index]` layers on *that* base too (`bufs[i].payload`
// names `bufs`, same as the top-level `&arr[i]` case) — and a bare
// identifier names a var. Neither branch yet knows whether its base name is
// itself a global or a local pointer/array (e.g. `m` in `m->data`, off a
// local `U1Msg *m = &u1_q[...]`); the caller resolves that ambiguity via
// resolveLocalAlias, since only it has the enclosing function's
// `locals`/`localAliases`. `->` vs `.` picks the default guess for "what
// kind of global is this, assuming it isn't local": arrow-on-a-global is
// (almost) always a real MCU peripheral register block (CMSIS's
// `((T*)BASE_ADDR)` pattern) — dot-on-a-global is the opposite, ordinary
// field access on a plain global struct/array, never a peripheral.
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
  if (n.type === 'field_expression') {
    const op = n.childForFieldName('operator')?.text;
    if (op === '->' || op === '.') {
      let base = n.childForFieldName('argument');
      while (base && base.type === 'subscript_expression') base = base.childForFieldName('argument');
      while (base && base.type === 'parenthesized_expression') base = base.namedChildren[0];
      if (!base || base.type !== 'identifier') return null;
      const field = n.childForFieldName('field')?.text;
      const baseName = resolveMacroName(base.text);
      return op === '->' ? { kind: 'periph', name: baseName, field } : { kind: 'var', name: baseName, field };
    }
  }
  if (n.type === 'identifier') return { kind: 'var', name: resolveMacroName(n.text) };
  return null;
}
// Follows resolveAddrExpr's result one step further when it turns out to
// name a local, not a real global/peripheral — `m->data` off
// `U1Msg *m = &u1_q[u1_q_tail];` first resolves (structurally) to
// {kind:'periph', name:'m', field:'data'}, since resolveAddrExpr alone can't
// tell a peripheral register block apart from a local struct pointer by AST
// shape; `m` being in `locals` is exactly that tell. localAliases (built once
// per function, see analyzeFunction) already carries `m`'s own resolved
// initializer, one level deep — not re-resolved recursively here, so a local
// pointer assigned from *another* local pointer's value is left unresolved
// (vanishingly rare, and not worth a fixed-point loop for).
function resolveLocalAlias(ref, locals, localAliases) {
  if (!ref) return null;
  return locals.has(ref.name) ? (localAliases.get(ref.name) || null) : ref;
}

// A while/for statement that never terminates by its own condition — the
// classic embedded "setup(); for(;;) { ... }" runtime-loop marker. Only
// direct statements of the given body are checked (findTopLevelInfiniteLoop),
// so a while(1) buried inside some unrelated helper never counts.
function isInfiniteLoopCondition(node) {
  if (!node) return true; // for(;;): no condition at all means "always true"
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
        // bare `return;` (no value) carries no information worth showing —
        // route straight into конец instead of drawing a return bubble.
        if (!s.namedChildren.length) return { entry: ctx.exitId, exits: [] };
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

// Two sub-passes over the same parsed trees (not two parses): analyzeFunction
// (below) needs MACRO_ALIASES fully built BEFORE it reads a single
// peripheral/var name off any function body, but a `#define` an alias
// resolves through can live in any OTHER file (a header, typically — see
// resolveMacroName's own doc comment) — so every file's defines must be
// collected before any file's functions are analyzed.
const parsedFiles = [];
const rawAliases = new Map();

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
  collectMacroAliases(root, rawAliases);
  parsedFiles.push({ filePath, src, root });
}
MACRO_ALIASES = resolveMacroChains(rawAliases);

// Struct field orders come first (a config-table array's own struct type is
// typically declared in a different file than the array itself, same
// header/source split as macro aliases above), then array-field peripherals
// against the now-complete struct map — see ARRAY_FIELD_PERIPHS's own doc
// comment.
const structFieldOrders = new Map();
for (const { root } of parsedFiles) collectStructFieldOrders(root, structFieldOrders);
ARRAY_FIELD_PERIPHS = new Map();
for (const { root } of parsedFiles) collectArrayFieldPeripherals(root, structFieldOrders, ARRAY_FIELD_PERIPHS);
ARRAY_ELEMENT_PERIPHS = new Map();
for (const { root } of parsedFiles) collectArrayElementPeripherals(root, ARRAY_ELEMENT_PERIPHS);
// Independent of the maps above (needs only each file's own functions), but
// same timing requirement — a helper can be defined in one file and called
// from another, so every file's helpers must be known before any file's
// functions are analyzed. See FUNC_RETURN_PERIPHS's own doc comment.
FUNC_RETURN_PERIPHS = new Map();
for (const { root } of parsedFiles) collectFuncReturnPeripherals(extractFunctions(root), FUNC_RETURN_PERIPHS);

const fileRecords = [];

for (const { filePath, src, root } of parsedFiles) {
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
  fileRecords.push({ filePath, basename, includes, funcs, vars, fpAssignments: collectFpAssignments(root) });
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

// key (bare variable name, or the last field of a `.`/`->` access) -> every
// real function's name ever assigned to something with that name, anywhere
// in the project — resolves indirect calls (see resolveCallTarget) the same
// "name-only, project-wide union" way periph/DMA targets already resolve
// through resolveAddrExpr. Filtered against functionsByName so a struct
// field that happens to be set to a non-function value (an int, a null,
// whatever) never contributes a bogus edge.
const fpTargets = new Map(); // key -> Set(funcName)
for (const f of fileRecords) {
  for (const { key, valueName } of f.fpAssignments) {
    if (!functionsByName.has(valueName)) continue;
    if (!fpTargets.has(key)) fpTargets.set(key, new Set());
    fpTargets.get(key).add(valueName);
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

// Peripheral instances: names used as `X->field` that never resolve to a real
// variable (see derefNames above), plus names named in NVIC_EnableIRQ(X_IRQn)
// calls. keyed by the bare instance name (e.g. "DMA1_Channel2", "USART1").
const peripherals = new Map();
function periph(name) {
  if (!peripherals.has(name)) {
    peripherals.set(name, {
      name, readers: new Set(), writers: new Set(), armers: new Set(), isrTargets: new Set(),
      fields: new Map(), // register name -> 'r' | 'w' | 'rw', unioned across the whole program
    });
  }
  return peripherals.get(name);
}

// Every literal `X->field` base name used anywhere in the program, gathered
// up front so the DMA controller/channel redirect below (see dmaChannelTarget)
// can tell a real channel/stream instance from one it would otherwise have to
// invent. Vendor headers give DMA1/DMA2 their own status-flag register (ISR
// on F1-style "channel" parts, LISR/HISR on F4/F7/H7-style "stream" parts)
// shared across every channel/stream, while each channel/stream keeps its own
// config registers under its own name (DMA1_Channel4, DMA1_Stream4) — so a
// flag test against the bare controller name is the *only* case where the
// code's own identifier doesn't already point at the specific unit it's
// about.
const allDerefNames = new Set();
for (const f of fileRecords) for (const fn of f.funcs) for (const n of fn.derefNames) allDerefNames.add(n);

// A DMA status flag's own macro name always ends in the channel/stream number
// it belongs to (TCIF4, HTIF4, CTCIF4, ...) regardless of family or how the
// bits are actually laid out inside the register — so this reads the target
// off the flag's own text rather than any bit-position arithmetic, which is
// what makes it work the same for F1-style channels and F4/F7/H7-style
// streams alike. Returns null (no redirect — the flag stays attributed to
// the bare controller) when there's no trailing number, or when the would-be
// target was never itself seen as a real `X->field` instance in this
// program — never invents a node purely from the naming convention.
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
      key, name: fn.name, file: f.basename, signature: fn.signature,
      desc: fn.desc || '', cfg: fn.cfg,
      isISR: ISR_RE.test(fn.name), isEntry: fn.name === 'main',
      calls: new Set(),      // funcKeys
      extCalls: new Set(),   // bare names
      callers: new Set(),    // funcKeys, filled below
      access: new Map(),     // varKey -> 'r' | 'w' | 'rw'
      periphAccess: new Map(), // peripheral name -> 'r' | 'w' | 'rw'
      periphFields: new Map(), // peripheral name -> Map(register -> 'r' | 'w' | 'rw')
      periphFlags: new Map(),  // peripheral name -> Map(register -> { r: Set(flag), w: Set(flag) })
      periphAddrRefs: new Map(), // peripheral name -> Map(register -> { kind: 'var'|'periph', name })
      arms: new Set(),         // peripheral names this function directly NVIC_EnableIRQ's
      loopCalls: new Set(),    // funcKeys called inside this function's own top-level infinite loop
      hasLoop: fn.hasLoop,     // a top-level while(1)/for(;;) was found, even if loopCalls ends up empty
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

// Adds rec -> calleeName as a call edge if calleeName is a real function;
// returns whether it found one (so callers can fall back to extCalls / skip
// only once every possibility — direct name, then fpTargets — is
// exhausted). Shared by the direct-call loop below and the indirect-call
// resolution right after it.
function addCallEdge(rec, calleeName, basename) {
  const candidates = functionsByName.get(calleeName);
  if (!candidates || !candidates.length) return false;
  const target = candidates.find(c => c.basename === basename) || candidates[0];
  const calleeKey = funcKey(calleeName, target.basename);
  if (calleeKey !== rec.key) rec.calls.add(calleeKey);
  return true;
}

for (const f of fileRecords) {
  for (const fn of f.funcs) {
    const rec = funcs.get(funcKey(fn.name, f.basename));

    for (const calleeName of fn.calls) {
      if (addCallEdge(rec, calleeName, f.basename)) continue;
      // calleeName didn't name a real function directly — it may still be a
      // function-pointer *variable* someone assigned a real function to
      // elsewhere (`fp = my_handler;` then `fp()`), same fallback as the
      // indirect (`->`/`.`/`[]`) call sites just below.
      const fpNames = fpTargets.get(calleeName);
      let any = false;
      if (fpNames) for (const realName of fpNames) any = addCallEdge(rec, realName, f.basename) || any;
      if (!any) rec.extCalls.add(calleeName);
    }
    for (const key of fn.indirectCalls) {
      const fpNames = fpTargets.get(key);
      if (fpNames) for (const realName of fpNames) addCallEdge(rec, realName, f.basename);
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
        continue;
      }
      if (fn.derefNames.has(name)) {
        // never resolved to a real var/func/extern, but seen as `name->field`:
        // a peripheral register block from a vendor header we didn't parse.
        //
        // For a bare DMA controller name (DMA1, DMA2 — never DMA1_Channel4,
        // that already names its own unit), a flag whose text carries a
        // channel/stream number gets attributed straight to that channel's
        // own peripheral instead of the shared controller (see
        // dmaChannelTarget) — everything else (a field with no named flag at
        // all, e.g. a blanket `IFCR = 0xFFFFFFFF` clear, or a flag with no
        // resolvable/real target) falls back to the controller name exactly
        // as before, so that genuinely ambiguous case still gets a node.
        const flds = fn.derefFields.get(name);
        const flagsByField = fn.derefFlags.get(name);
        const isDmaBus = DMA_BUS_RE.test(name);

        // redirect target name -> { fields: Map(field -> mode), flags: Map(field -> {r,w}) }
        const buckets = new Map();
        function bucket(t) {
          let b = buckets.get(t);
          if (!b) { b = { fields: new Map(), flags: new Map() }; buckets.set(t, b); }
          return b;
        }

        if (flds) {
          for (const [field, fm] of flds) {
            const flagRec = flagsByField && flagsByField.get(field);
            let residual = fm; // mode left unaccounted for by a redirected flag
            // 'r' stays a Set(flagName), 'w' is now a Map(flagName ->
            // 'set'|'clear'|'both') — handled separately since their element
            // shapes differ (see mergeFlagPolarity/addFlagNames above).
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
              // carry over the flag names for whichever direction(s) weren't
              // redirected above — for a non-DMA peripheral (isDmaBus false)
              // that's simply everything flagRec has, same as pre-redirect.
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
          bucket(name); // bare access with no `->field` breakdown at all
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
          // carry the per-register breakdown onto both the function (for its own
          // "Связи" diagram) and the peripheral (union, for level 0's node label)
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
          // were found on (see resolveAddrExpr) — they only ever live on the
          // bucket that resolved to that exact same name (never a DMA-bus
          // redirect target; CPAR/CMAR live on the channel's own name, e.g.
          // "DMA1_Channel4", which never matches DMA_BUS_RE in the first
          // place, so isDmaBus is always false for it).
          if (tName === name) {
            const addrRefs = fn.derefAddrRefs.get(name);
            if (addrRefs && addrRefs.size) {
              let ra = rec.periphAddrRefs.get(tName);
              if (!ra) { ra = new Map(); rec.periphAddrRefs.set(tName, ra); }
              for (const [field, ref] of addrRefs) {
                // a 'var' ref only ever carries the bare identifier text at
                // this point (resolveAddrExpr has no file context) — resolve
                // it to a real varKey now, same rule as any other access
                // (resolveVar), and drop it if it doesn't name an actual
                // global/static (e.g. a param/local resolveAddrExpr can't
                // tell apart from a global by AST shape alone).
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
      // NVIC_EnableIRQ's actual register write (NVIC->ISER[...] |= ...) lives
      // inside a CMSIS core header (core_cm3.h) this tool doesn't parse, and
      // even when that header *is* fed in, the call site says "NVIC_EnableIRQ"
      // while the real body is named "__NVIC_EnableIRQ" (CMSIS's own
      // `#define NVIC_EnableIRQ __NVIC_EnableIRQ` alias) — invisible to a
      // syntax-only parser with no preprocessor, so the two never link up.
      // Synthesized here instead, flowing through the exact same
      // register/flag rendering pipeline as a real access (register "ISER",
      // one flag per interrupt line actually armed) so it renders, groups,
      // and hover-reveals identically to every other peripheral — no special
      // casing anywhere else. "IRQ_" is a throwaway one-segment prefix:
      // shortFlagName always strips exactly the first segment for display
      // (see its own comment), so this makes the *literal* IRQn identifier
      // (`DMA1_Channel7_IRQn`) the thing that survives onto the edge, not
      // some invented shorthand. User request, 2026-07-16.
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
// handler's base name (with the _IRQHandler/_Handler/_ISR suffix and ISR_
// prefix stripped) contains the peripheral name as a whole underscore-
// delimited segment or run — this also covers shared vectors that name
// several peripherals at once (e.g. TIM1_UP_TIM10_IRQHandler matches both
// TIM1 and TIM10). A peripheral node is never created from this match alone —
// only real register access or an NVIC_EnableIRQ call brings one into being
// (see `periph()` above) — this step only adds the trigger edge to it.
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

// ---------------------------------------------------------------------------
// Importance of globals: how many distinct functions use the variable, with a
// bonus for crossing file boundaries (a var shared by 3 files carries more
// architecture than one passed between 3 neighbors) and for volatile (ISR
// channels matter even with few users). Used to size/tint nodes in overview
// diagrams: top ~20% render bold, single-user vars render small and dim.
// ---------------------------------------------------------------------------

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

function varTier(v) {
  if (v.isExternal) return 'normal';
  if (v.score >= hotCut && v.users >= 3) return 'hot';
  // volatile still dims when it's genuinely single-use (e.g. a flag only
  // ever touched inside one ISR) — being volatile shifts the score (+2
  // bonus above) but must not by itself exempt a var from looking minor,
  // or every volatile var ends up rendered identically important
  if (v.users <= 1) return 'minor';
  return 'normal';
}
// Same hot/normal/minor 3-way split as varTier, but for "how big is this
// count relative to its peers" instead of "how often is this var touched" —
// used to size/tint a collapsed variable-bundle node by how many variables
// it hides, the same way a single variable gets sized by its usage.
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
// Graphviz emission (all diagrams — see the "graphviz, not mermaid" comment
// below for why every build*Diagram function went this way)
// ---------------------------------------------------------------------------

const sanitize = s => s.replace(/[^A-Za-z0-9_]/g, '_');
const fnId = key => 'f_' + sanitize(key);
const varId = key => 'v_' + sanitize(key);
const extId = name => 'x_' + sanitize(name);
const periphId = name => 'p_' + sanitize(name);

function fnClass(fn) {
  return fn.isISR ? 'isr' : fn.isEntry ? 'entry' : 'fn';
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

// Overview: which vars are interesting enough to show at whole-program level
function overviewVars() {
  return [...varDefs.values()].filter(v =>
    v.isVolatile || (v.readers.size + v.writers.size) >= 2 || new Set([...v.readers, ...v.writers]).size >= 2,
  );
}

// Overview/aggregate/include moved to graphviz alongside level 0: same
// reasoning applies — these mix functions, globals and files with lots of
// many-to-many edges (not a clean call-tree DAG the way a single function's
// CFG is), so they're closer in shape to level 0 than to the diagrams ELK
// stays good at (see the comment on the graphviz section above).
async function buildOverviewDiagram() {
  const vars = overviewVars();
  const nodeCount = funcs.size + vars.length;
  if (nodeCount > 130) return buildAggregateDiagram();

  const nodeLines = [];
  const edgeLines = [];
  const varNodeLines = [];
  const varEdgeLines = [];
  const shownVars = new Set(vars.map(v => v.key));
  const multiFile = fileRecords.length > 1;

  for (const f of fileRecords) {
    const fnsHere = [...funcs.values()].filter(fn => fn.file === f.basename);
    const varsHere = vars.filter(v => v.file === f.basename);
    if (fnsHere.length === 0 && varsHere.length === 0) continue;
    if (fnsHere.length) {
      if (multiFile) {
        nodeLines.push(`  subgraph cluster_${sanitize(f.basename)} {`,
          `    label="${dotEsc(f.basename)}"; fontsize=11; fontcolor="#71717a"; color="#cbd5e1";`);
      }
      for (const fn of fnsHere) nodeLines.push(dotFnNode(fn));
      if (multiFile) nodeLines.push('  }');
    }
    if (varsHere.length) {
      // graphviz merges same-named subgraphs wherever they're reopened in
      // the file, so the file's vars still land inside its own cluster even
      // though they're built into a separate array (omitted, not just
      // hidden, when the "переменные" toggle is off — see renderDotAll).
      // label/color repeated here (not just in the fnsHere branch above)
      // because a data-only file like config.c has vars but no functions,
      // so this may be the only branch that ever opens cluster_<file>.
      if (multiFile) {
        varNodeLines.push(`  subgraph cluster_${sanitize(f.basename)} {`,
          `    label="${dotEsc(f.basename)}"; fontsize=11; fontcolor="#71717a"; color="#cbd5e1";`);
      }
      for (const v of varsHere) varNodeLines.push(dotVarNode(v, { tiered: true }));
      if (multiFile) varNodeLines.push('  }');
    }
  }
  for (const v of vars.filter(v => v.isExternal)) varNodeLines.push(dotVarNode(v));

  for (const fn of funcs.values()) {
    for (const calleeKey of fn.calls) edgeLines.push(dotCallEdge(fn.key, calleeKey));
    for (const [varKey, mode] of fn.access) {
      if (shownVars.has(varKey)) varEdgeLines.push(...dotAccessEdges(fn.key, varKey, mode));
    }
  }
  const { svgs, hasVars } = await renderDotAll(nodeLines, edgeLines, varNodeLines, varEdgeLines);
  return { svgs, varsToggle: hasVars };
}

async function buildAggregateDiagram() {
  // Too many nodes: collapse to file level
  const nodeLines = [];
  const edgeLines = [];
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
    nodeLines.push(dotFileNode(f.basename,
      [`<FONT POINT-SIZE="9">функций: ${f.funcs.length} &#183; глобалов: ${f.vars.defs.length}</FONT>`]));
  }
  for (const [k, n] of callAgg) {
    const [a, b] = k.split('|');
    edgeLines.push(dotEdge(`file_${sanitize(a)}`, `file_${sanitize(b)}`, { style: 'dashed', label: `вызовов: ${n}` }));
  }
  for (const [k, n] of varAgg) {
    const [a, b] = k.split('|');
    edgeLines.push(dotEdge(`file_${sanitize(a)}`, `file_${sanitize(b)}`, { dir: 'none', label: `общих переменных: ${n}` }));
  }
  const { svgs } = await renderDotAll(nodeLines, edgeLines);
  return { svgs, varsToggle: false };
}

async function buildIncludeDiagram() {
  const basenameSet = new Set(fileRecords.map(f => f.basename));
  const nodeLines = [];
  const edgeLines = [];
  const seen = new Set();
  for (const f of fileRecords) nodeLines.push(dotFileNode(f.basename));
  for (const f of fileRecords) {
    for (const inc of f.includes) {
      if (!basenameSet.has(inc.raw)) continue;
      const key = `${f.basename}|${inc.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edgeLines.push(dotEdge(`file_${sanitize(f.basename)}`, `file_${sanitize(inc.raw)}`));
    }
  }
  // file-include graphs are the textbook DAG-shaped case (see the Go
  // package-dependency example this whole switch started from) — dot's
  // rank columns are the right read here, unlike level 0/overview
  const { svgs } = await renderDotAll(nodeLines, edgeLines);
  return { svgs, defaultEngine: 'dot', varsToggle: false };
}

// The file's own functions/globals (clustered, solid) plus one hop of
// neighbors (ghost, dashed) — always shown flat, no size-based collapsing.
// This used to fold large files into click-to-expand grey placeholder
// groups because ELK's layout could choke on the combined size; graphviz
// doesn't have that failure mode at the sizes this tool sees in practice,
// so the extra collapse/expand machinery (and the client-side mermaid-source
// recomposition it needed) isn't worth carrying.
async function buildFileDiagram(f) {
  const fnsHere = [...funcs.values()].filter(fn => fn.file === f.basename);
  const fnKeysHere = new Set(fnsHere.map(fn => fn.key));
  const varsHere = [...varDefs.values()].filter(v => v.file === f.basename);
  const varKeysHere = new Set(varsHere.map(v => v.key));

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

  const nodeLines = [`  subgraph cluster_this {`,
    `    label="${dotEsc(f.basename)}"; fontsize=11; fontcolor="#71717a"; color="#cbd5e1";`];
  for (const fn of fnsHere) nodeLines.push(dotFnNode(fn));
  nodeLines.push('  }');
  for (const g of ghostFns.values()) nodeLines.push(dotFnNode(g, { ghost: true, withFile: true }));
  for (const ec of extCalls) nodeLines.push(dotExtNode(ec));

  // same reopened-subgraph trick as buildOverviewDiagram: the file's own
  // vars still land inside cluster_this even though they're a separate
  // array, omitted entirely (not hidden) when "переменные" is off
  const varNodeLines = ['  subgraph cluster_this {'];
  for (const v of varsHere) varNodeLines.push(dotVarNode(v));
  varNodeLines.push('  }');
  for (const g of ghostVars.values()) varNodeLines.push(dotVarNode(g, { ghost: true, withFile: true }));

  const shownFns = new Set([...fnKeysHere, ...ghostFns.keys()]);
  const shownVars = new Set([...varKeysHere, ...ghostVars.keys()]);
  const edgeLines = [];
  const varEdgeLines = [];
  const edgeSeen = new Set();
  const pushEdge = (arr, e) => { if (!edgeSeen.has(e)) { edgeSeen.add(e); arr.push(e); } };
  for (const fnKey of shownFns) {
    const fn = funcs.get(fnKey);
    for (const calleeKey of fn.calls) {
      if (shownFns.has(calleeKey) && (fnKeysHere.has(fnKey) || fnKeysHere.has(calleeKey))) {
        pushEdge(edgeLines, dotCallEdge(fnKey, calleeKey));
      }
    }
    if (fnKeysHere.has(fnKey)) {
      for (const ec of fn.extCalls) pushEdge(edgeLines, dotExtCallEdge(fnKey, ec));
    }
    for (const [varKey, mode] of fn.access) {
      if (shownVars.has(varKey) && (fnKeysHere.has(fnKey) || varKeysHere.has(varKey))) {
        dotAccessEdges(fnKey, varKey, mode).forEach(e => pushEdge(varEdgeLines, e));
      }
    }
  }
  const { svgs, hasVars } = await renderDotAll(nodeLines, edgeLines, varNodeLines, varEdgeLines);
  return { svgs, defaultEngine: 'dot', varsToggle: hasVars };
}

const CFG_SHAPE = { term: 'ellipse', ret: 'ellipse', cond: 'diamond', loop: 'diamond', call: 'box', jump: 'ellipse' };
const CFG_CLASS = { term: 'cfgterm', ret: 'cfgterm', cond: 'cfgcond', loop: 'cfgcond', call: 'cfgcall', jump: 'cfgjump' };

// Flowchart of the function's own control flow (branches, loops, calls in
// order) — a single-entry DAG (plus loop backedges), exactly the shape dot's
// rank layout is built for; see the fsm.html/finite-automaton comparison
// this defaulted it to 'dot' from. Returns { svgs, links } — links maps CFG
// node id -> root-relative href for double-click navigation (ids like "c3"
// are only unique within this one diagram, so they travel with the page as
// window.CFG_LINKS, not graph-data.js).
async function buildCfgDiagram(fn) {
  if (!fn.cfg) return null;
  const nodeLines = [];
  const edgeLines = [];
  const links = {};
  for (const n of fn.cfg.nodes) {
    const label = n.label.split('\n').map(dotEsc).join('<BR/>');
    nodeLines.push(dotNode(n.id, [label], CFG_SHAPE[n.kind] || 'box', CFG_CLASS[n.kind] || 'cfgstmt'));
    // clickable: jump to the first call target defined in this codebase
    for (const cname of n.calls || []) {
      const cands = functionsByName.get(cname);
      if (cands && cands.length) {
        const target = cands.find(c => c.basename === fn.file) || cands[0];
        links[n.id] = `functions/${pageName(funcKey(cname, target.basename))}.html`;
        break;
      }
    }
  }
  for (const e of fn.cfg.edges) {
    edgeLines.push(dotEdge(e.from, e.to, e.label ? { label: e.label } : {}));
  }
  const { svgs } = await renderDotAll(nodeLines, edgeLines, [], [], { rankdir: 'TB' });
  return { svgs, defaultEngine: 'dot', varsToggle: false, links };
}

// ---------------------------------------------------------------------------
// Level 0 emission (graphviz, not mermaid)
// ---------------------------------------------------------------------------
// Every other diagram is close enough to a DAG (or is turned into one, like
// the call tree) that ELK's layered algorithm has a real rank order to work
// with. Level 0 doesn't: peripherals arm/trigger each other and loop back
// into entries (main arms UART, UART's ISR arms TIMER, TIMER's ISR arms UART
// again), so there's no single direction that's "downstream" for the whole
// graph, and ELK's layered engine was visibly straining against that (see the
// elk.mrtree/elk.force notes below, in the code this replaced). Graphviz's
// `dot` handles this the same way ELK would try to (an internal feedback-arc
// heuristic picks which edges to treat as "back" for ranking purposes) but
// its spline router is noticeably better at bending edges around unrelated
// nodes instead of through them — verified against a synthetic sample with
// exactly this arm/trigger cycle before committing to the switch.
const dotEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dotNode(id, rows, shape, cls, extra = '') {
  return `  ${id} [id="${id}" class="${cls}" shape=${shape} label=<${rows.join('<BR/>')}>${extra}];`;
}
const dotKindRow = text => `<FONT POINT-SIZE="10">${dotEsc(text)}</FONT>`;
// ghost nodes (one hop outside the thing this diagram is centered on — a
// neighboring file's function, a var defined elsewhere) need a dashed border
// on top of the fill, which means restating style= in full rather than
// layering onto the graph-level `node [style=filled]` default (a node's own
// style= attribute replaces the inherited one, it doesn't merge with it)
const GHOST_STYLE = ' style="filled,dashed"';

// every flag name an ISR touches anywhere in its body — read-tested
// (`X->SR & FLAG`, "is this the source") or write-set/cleared (`X->SR &= ~FLAG`,
// the near-universal "acknowledge this interrupt" pattern); see
// periphFlags/derefFlags. Deduped and capped, since a handler that juggles
// several sources (e.g. a shared DMA IRQ) can rack up a dozen.
function isrFlagList(fn, cap = 6) {
  const all = new Set();
  // Read-tested flags only (`if (X->SR & FLAG)`) — this list answers "which
  // interrupt source is this handler reacting to", and that's decided by the
  // condition it was dispatched on, not by whatever it writes afterwards
  // (acknowledging/clearing the flag, e.g. `DMA1->IFCR = DMA_IFCR_CTCIF7`, is
  // bookkeeping for *this same* source, not a source of its own — showing it
  // next to the tested flag reads as two separate events instead of one).
  // Enable/on bits (DMA_CCR_EN, RCC_CR_HSEON...) are excluded for the same
  // reason even on the read side — they arm something, they don't report an
  // event; see isEnableFlagName. The leading "DMA_" is dropped too: the
  // handler's own name already says which DMA instance this is, so it's dead
  // weight on an already-tight node.
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
function dotVarNode(v, { tiered = false, ghost = false, withFile = false } = {}) {
  const kind = v.isExternal ? 'ext var' : v.isVolatile ? 'volatile' : 'var';
  let cls = ghost || v.isExternal ? 'ghost' : 'gvar';
  if (tiered && !ghost && !v.isExternal) {
    const tier = varTier(v);
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
// external call target (library function/macro, never defined in the
// scanned sources) — same ghost treatment as an out-of-file neighbor
function dotExtNode(name) {
  return dotNode(extId(name), [dotKindRow('ext'), `<B>${dotEsc(name)}</B>`], 'box', 'ghost', GHOST_STYLE);
}
// a bit name shaped like "this arms/turns something on" — the near-universal
// STM32 convention is a trailing EN or ON (RCC_APB2ENR_IOPAEN, DMA_CCR_EN,
// RCC_CR_HSEON/PLLON), as opposed to a status/test flag that never ends that
// way (USART_SR_IDLE, DMA_ISR_TCIF7). USART/UART's own master-enable bit
// breaks that suffix pattern (`USART_CR1_UE`, "USART Enable" — a genuine,
// separate CMSIS convention, not a typo), added 2026-07-16 once plain `=`
// assignment decomposition (see analyzeFunction's addFlagNames) started
// surfacing it. Used to decide whether an edge's default label reads its
// enable bit's own register-qualified name instead of sitting blank — see
// dotPeriphAccessEdges.
const ENABLE_FLAG_RE = /(?:EN|ON|UE)$/;
function isEnableFlagName(name) { return ENABLE_FLAG_RE.test(name); }
// STM32 CMSIS bit-flag macros are named <family>_<register>_<bit>
// (`RCC_APB2ENR_IOPAEN`, `DMA_CCR_EN`, `USART_SR_IDLE`, ...) — only the
// leading family segment repeats information the diagram already carries
// elsewhere (the node's own label, e.g. DMA1_Channel7), so it's the one
// dropped here; the register segment (`CCR`, `SR`, `APB2ENR`, ...) stays —
// unlike the family, it's real information periphDirDetail doesn't already
// surface anywhere else (register-grouped detail lines used to exist but
// were removed; see periphDirDetail's own comment), and dropping it too
// briefly (2026-07-16) turned out to lose too much — `DMA_CCR_EN` -> `EN`
// reads as "some enable bit, could be any register" instead of "the CCR
// enable bit". First tried keeping *only* the bit name (dropping both family
// and register, matching an earlier RCC-only special case); reverted after
// user feedback the same day — register context matters even when the
// family doesn't. Any flag name with more than one underscore-delimited
// segment drops just its first; a bare one-segment name is returned as-is.
// Only strips when at least two segments remain afterward: a genuine CMSIS
// name (USART_CR1_TXEIE, 3 segments) still loses its redundant family
// prefix, but a project-specific 2-segment pin macro (FAN_PS — "which pin",
// not a CMSIS bit name) would otherwise shorten to a bare, contextless "PS"
// that could be any "_PS" pin in the whole project (user report 2026-07-23,
// real project) — left whole instead.
function shortFlagName(flagName) {
  const idx = flagName.indexOf('_');
  if (idx === -1) return flagName;
  const rest = flagName.slice(idx + 1);
  return rest.includes('_') ? rest : flagName;
}
// one direction's full register/bit breakdown from a Map(register ->
// 'r'|'w'|'rw') plus the matching Map(register -> {r,w: Set(flag)}) — every
// register whose mode includes `dir` gets one line, showing the *specific
// bit* touched in that direction when one was detected and falling back to
// the bare register name otherwise (a plain non-decomposable access, e.g.
// `CCR = 0x1234` or `x = REG->DR`). This is no longer the edge's *visible*
// label (see dotPeriphAccessEdges) — a long version of it used to be baked
// straight into the graphviz label, and neato has no box to fit a tall
// multi-line label against, so it would drift the label away from the edge
// entirely once a function touched enough registers at once (RCC's
// clock/peripheral-enable sequence in main being the worst offender: 5
// registers, all correctly attributed to RCC, just unreadably far from the
// RCC node). Returned separately from the edge's own default text now, and
// revealed only on hover — see the .periph-detail/.periph-default CSS pair.
// \n is graphviz's own line-break escape for a plain (non-HTML) label, not a
// literal newline. Capped, so a call-tree touching a dozen registers doesn't
// grow a giant hover block.
function periphDirDetail(fields, flags, dir, cap = 6) {
  if (!fields || !fields.size) return { detail: '', hasEnable: false, enableLabel: '' };
  let regs = [...fields.entries()].filter(([, m]) => m.includes(dir)).map(([f]) => f).sort();
  if (!regs.length) return { detail: '', hasEnable: false, enableLabel: '' };
  // GPIOx's BSRR/BRR are STM32's standard atomic pin set/reset register
  // pair — one bit name written via both (`X->BSRR = 1<<PIN` somewhere,
  // `X->BRR = 1<<PIN` elsewhere) is exactly the same "arm/disarm"
  // relationship one register's own |=/&=~ pair already gets a single
  // ~clear/set line for — but split across two whole *registers* instead of
  // one bit-op, it fell through as two separate lines with the identical
  // bare bit name and no register shown to tell them apart, reading as a
  // flat-out duplicate (user report 2026-07-23, real project: "B_GS, B_GS").
  // Fold BRR's bits into BSRR's own (as 'clear' — BRR only ever resets) so
  // the one shared per-register-loop below renders them on the SAME line,
  // through the exact same notation.
  if (dir === 'w' && regs.includes('BSRR') && regs.includes('BRR')) {
    const merged = new Map((flags && flags.get('BSRR') && flags.get('BSRR').w) || []);
    const brrBits = flags && flags.get('BRR') && flags.get('BRR').w;
    if (brrBits) for (const fl of brrBits.keys()) mergeFlagPolarity(merged, fl, 'clear');
    flags = new Map(flags); // shallow clone — never mutate the caller's own data
    flags.set('BSRR', { r: new Set(), w: merged });
    regs = regs.filter(r => r !== 'BRR');
  }
  let hasEnable = false, enableLabel = '';
  const names = regs.map(reg => {
    const bits = flags && flags.get(reg) && flags.get(reg)[dir];
    if (bits && bits.size) {
      if (dir === 'w') {
        // bits: Map(flagName -> 'set'|'clear'|'both') — a bit only ever
        // cleared here (`&= ~FLAG`, never `|= FLAG` anywhere in the same
        // tree) gets a literal ~ prefix so it reads as "turned off", not
        // "turned on". 'both' (armed at least once, even if also disarmed
        // elsewhere — the disable-then-rearm restart idiom, e.g. u1_kick's
        // `CCR &= ~DMA_CCR_EN; ...; CCR |= DMA_CCR_EN;`) shows *both* forms,
        // clear before set — that's the actual disable-then-rearm sequence
        // for the common case where they're both in the one function this
        // detail is for; across a whole reachable call tree there's no
        // single well-defined order (different callees, branches, ...), so
        // this is a reasonable default reading, not a claimed causal fact.
        // User request (2026-07-20): show "~_en и просто _en" — seeing only
        // plain "EN" collapsed the two events into one and read as if the
        // bit were never cleared at all.
        const sorted = [...bits.keys()].sort();
        if (!hasEnable) {
          // first enable-shaped bit found (regs already walked in sorted
          // order, so this is deterministic) — shortFlagName keeps the
          // register segment (`CCR_EN`, not bare `EN`), used as-is for the
          // edge's always-visible default label (see dotPeriphAccessEdges):
          // the register the bit lives on is the whole point, a bare "EN"
          // doesn't say which register got armed. Excludes pure-'clear'
          // bits — this label means "this edge arms the peripheral", and a
          // bit that's only ever cleared here does the opposite.
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
  return { detail: shown.join('\\n'), hasEnable, enableLabel };
}
function dotPeriphNode(p) {
  const hot = p.isrTargets.size > 0 && (p.readers.size + p.writers.size) > 0;
  return dotNode(periphId(p.name), [dotKindRow('периферия'), `<B>${dotEsc(p.name)}</B>`], 'hexagon', hot ? 'periphhot' : 'periph');
}
// peripheral as it appears on a single function's "Связи" diagram — same
// compact block as dotPeriphNode, register detail lives on the edge instead
// (see periphDirRegLabel).
function dotPeriphRelNode(name) {
  return dotNode(periphId(name), [dotKindRow('периферия'), `<B>${dotEsc(name)}</B>`], 'hexagon', 'periph');
}
function dotVarBundleNode(id, vars, tier) {
  let cls = 'gvar';
  if (tier === 'hot') cls = 'gvarhot'; else if (tier === 'minor') cls = 'gvarminor';
  const rows = vars.map(v => v.name).sort().map(name => `<B>${dotEsc(name)}</B>`);
  return dotNode(id, rows, 'cylinder', cls);
}
// file-level node used by the overview/aggregate/include diagrams
function dotFileNode(basename, extraRows = []) {
  return dotNode(`file_${sanitize(basename)}`, [dotKindRow('файл'), `<B>${dotEsc(basename)}</B>`, ...extraRows], 'box', 'fn');
}

function dotEdge(from, to, { dir = 'forward', style, label, penwidth, id, color } = {}) {
  const attrs = [`dir=${dir}`];
  // explicit id lets post-render SVG processing find this exact edge back
  // (graphviz's own default is just "from&#45;&gt;to" in a <title>, which
  // collides whenever two edges share the same pair of nodes) — see
  // injectPeriphDetailLabels.
  if (id) attrs.push(`id="${dotEsc(id)}"`);
  if (style) attrs.push(`style=${style}`);
  if (color) attrs.push(`color="${color}", fontcolor="${color}"`);
  if (label) {
    attrs.push(`label="${dotEsc(label)}"`);
    // neato/fdp place nodes purely by spring simulation on the *node* boxes —
    // a multi-line label text has no box of its own competing for room, so a
    // labeled edge between two otherwise strongly-connected nodes (a
    // peripheral and its own ISR is the classic case) can end up shorter than
    // the label needs, spilling the text onto one of the nodes. len sets a
    // longer preferred spring length just for edges that actually carry a
    // label, so they get more room without stretching the rest of the
    // diagram. Ignored by dot (rank/ranksep governs edge length there), so
    // harmless to always include.
    attrs.push('len=3.5');
  }
  if (penwidth) attrs.push(`penwidth=${penwidth}`);
  return `  ${from} -> ${to} [${attrs.join(', ')}];`;
}
// Every var shown at level 0 is (by construction) written by one entry and
// read by a different one, so there's no single "direction" that's actually
// true for the whole edge — an arrowhead would just be noise. Plain,
// undirected connector instead (solid if the entry accesses it directly,
// dashed if only somewhere down its call tree); which endpoint the edge
// list is written first is decided once per bundle purely to keep a bundle
// shared by several entries from being pulled toward all of them at once —
// it says nothing about read vs write.
function dotAccessLink(fnKey, targetId, direct, downstream) {
  const a = fnId(fnKey);
  const [from, to] = downstream ? [a, targetId] : [targetId, a];
  return dotEdge(from, to, { dir: 'none', style: direct ? undefined : 'dashed' });
}
// always 0-2 separate directed edges (never dir=both) — a register that's
// both read and written gets one line on each edge instead of one
// double-headed arrow, so its two labels ("what's written" / "what's read")
// don't have to be crammed together at the same spot on the same line.
//
// Line style here is purely read vs write — solid (write, entry -> periph)
// vs dashed (read, periph -> entry) — never direct-vs-indirect the way
// dotAccessLink's var edges use it. Peripheral edges used to also fold in
// direct/indirect (solid if the entry's own body touches the register,
// dashed if only somewhere down its call tree), but that distinction turned
// out to carry no real information at level 0: level 0 is already an
// aggregate over an entry's *whole* reachable behavior, so "does the entry
// touch this itself or one call away" is an arbitrary implementation detail,
// not a fact worth a whole visual channel — and it actively misled a reader
// into treating "dashed" as some flavor of "read" (the two encodings clashed
// on exactly the read edges, which were dashed *and* an actual read at the
// same time whenever the read happened to also be indirect). Dropped after
// user discussion (2026-07-16): read/write is the fact that matters here;
// direct/indirect is still tracked internally (aggregateEntryInfo's
// `.direct`, used by the setup/cyclic overlap math) but no longer drawn.
//
// This used to also fold in a peripheral's "armed" state (`this entry calls
// NVIC_EnableIRQ on this peripheral`), on the theory that arming and writing
// an enable bit are really one fact ("this entry turns the peripheral on")
// told twice. Dropped (2026-07-16) now that arming has its own honest home —
// a synthetic NVIC node (see the `armCalls` handling in analyzeFunction) — so
// this edge no longer needs to stand in for it: a pure NVIC_EnableIRQ arm
// with no matching register write reachable from this entry used to show a
// bare "_EN" here with nothing behind it (confusing — "_EN" implies an
// actual enable bit, and there wasn't one), and now correctly shows nothing
// at all on *this* edge; the arm fact still shows, just on the entry's edge
// to NVIC instead. This edge is now purely "peripheral enable" in the simple
// sense — a real register bit, no interrupt involved. Default label is the
// enable bit's own register-qualified name (`CCR_EN`, `APB2ENR_IOPAEN`, ...)
// whenever periphDirDetail found one. The full register/flag breakdown never
// sits in the graphviz label itself any more (see periphDirDetail for why —
// tall multi-line labels drift away from long edges under neato) and is
// instead returned via `details`, for the caller to bake into the SVG as a
// hidden hover-reveal (see injectPeriphDetailLabels in
// buildLevel0Diagram/buildFunctionDiagram and the .periph-detail/
// .periph-default CSS pair).
function dotPeriphAccessEdges(fnKey, periphName, fields, flags, idPrefix) {
  const a = fnId(fnKey), b = periphId(periphName);
  const lines = [];
  const details = [];

  const w = periphDirDetail(fields, flags, 'w');
  const r = periphDirDetail(fields, flags, 'r');

  if (w.detail) {
    // RCC is excluded from the "_EN" callout entirely: its own enable bits
    // (`RCC_AHBENR_DMA1EN`, `RCC_APB2ENR_USART1EN`, ...) are clock gates for
    // *other* peripherals, not a fact about RCC itself — RCC always gets
    // some clock-enable write in any real project, so singling out
    // whichever one happened to be found first (of what's often several,
    // one per peripheral main brings up) isn't meaningful the way it is for
    // an actual peripheral arming itself. User request (2026-07-16): "для
    // RCC исключение, там куча разных EN которые относятся не к нему".
    const defaultLabel = periphName === 'RCC' ? '' : (w.hasEnable ? w.enableLabel : '');
    // a blank default still needs *some* label so graphviz reserves a real
    // text anchor to clone from — a lone space renders as nothing visible.
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

// A DMA channel's data source/destination — a wholly different relationship
// from the plain register read/write edges above ("who touched this
// register" vs "where does the data physically end up") — so it gets its own
// color rather than reusing solid=write/dashed=read, which would otherwise
// read as just another access to the channel's own registers. Direction
// follows the transfer's real direction (source -> channel -> destination),
// not read/write of CPAR/CMAR themselves. label is the register the address
// came from (CPAR/CMAR itself), shown small and always-visible; detail is
// the *concrete* thing that register resolved to — the specific peripheral
// register for a CPAR edge (e.g. "DR", so hovering "CPAR" answers "which
// register on USART1 specifically" the same way an ordinary access edge's
// hover reveals its own register breakdown — see periphDirDetail) or the
// variable's own name for a CMAR edge (redundant with the destination node's
// own label most of the time, but still useful when that node sits far from
// the edge's own midpoint). Reuses the exact same hide-until-hover mechanism
// as dotPeriphAccessEdges (.periph-detail/.periph-default, spliced in by
// injectPeriphDetailLabels) — pass detail only when there's something worth
// revealing; the caller skips the edgeDetails entry entirely otherwise.
const DMA_FLOW_COLOR = '#0d9488';
function dotDmaFlowEdge(fromId, toId, label, id, detail) {
  const line = dotEdge(fromId, toId, { style: 'dashed', label, id, color: DMA_FLOW_COLOR });
  return { line, detail: detail ? { id, defaultLabel: label, detail } : null };
}

// Splices each periph edge's full register/flag breakdown into its already-
// rendered SVG group as a hidden sibling of the (short, static) label text —
// see dotPeriphAccessEdges/periphDirDetail for why the breakdown never goes
// through graphviz's own label layout in the first place (tall multi-line
// labels drift away from long edges under neato). `details` is the
// {id, defaultLabel, detail} list assembleLevel0/buildFunctionDiagram
// collected while building the edges themselves, so this only ever has to
// re-find each edge's *own* label text, not guess at one.
// Revealed by pure CSS (.periph-detail/.periph-default, keyed off the .hl
// class the existing hover system already toggles) — no client JS needed for
// the swap itself.
// Perpendicular push, off graphviz's own on-the-line anchor point — a
// peripheral and its own ISR is the classic short edge (see dotEdge's `len`
// comment), and `len` is only a spring *preference*, not a hard constraint,
// so a short-enough edge still crowds a label against the nearby node even
// with it set. Same perpendicular-offset idea bendOneEdge already uses to
// bow anti-parallel edge pairs, applied here to text position instead of the
// path curve. Two tiers, not one flat distance (2026-07-16, after "стало
// лучше" on the first flat-16 version, then "по умолчанию можно ближе на
// 50%, а при разворачивании — больше строк, надо отдалить"): the
// always-visible default label sits close (PUSH_NEAR), the hover-revealed
// detail stack sits further out, growing with how many lines it has to fit
// (PUSH_NEAR + PUSH_PER_LINE * lines) — a lone one-line register still gets
// a real, visible offset (not zero), a five-register RCC edge gets
// noticeably more room.
const PERIPH_LABEL_PUSH_NEAR = 8;
const PERIPH_LABEL_PUSH_PER_LINE = 6;
// Direction comes from the path's *local* segment nearest the label's own
// point, not the overall start-to-end chord — a short, simple edge (a single
// Q bezier) has its tangent-at-midpoint exactly equal to the chord (a
// property of quadratic beziers), so the two agree there, but a longer edge
// routed around other nodes can have several segments whose local direction
// differs noticeably from the overall chord; using the far-away endpoints in
// that case pushes in a direction that doesn't actually clear the curve
// nearby. dot/neato path `d` strings interleave on-curve points with bezier
// control points, but treating all of them as vertices of a polyline is a
// fine approximation for direction purposes here — this only picks the
// segment, not the vertices' data.
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
function injectPeriphDetailLabels(svg, details) {
  if (!details.length) return svg;
  for (const { id, detail } of details) {
    // class="edge[^"]* — not a literal "edge": a DMA-flow edge's class is
    // "edge dma-flow" (dotDmaFlowEdge's cls), which a literal class="edge"
    // match would silently skip, dropping its hover-detail.
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
// Two edges between the exact same pair of nodes but opposite direction (a
// write-direction periph/var access edge and its read-direction sibling)
// otherwise draw as one perfectly straight, perfectly coincident line —
// nothing in plain DOT tells them apart, so the pair reads as a single
// misleadingly-bidirectional arrow. Pinning each to a different corner of
// the node via tailport/headport was tried and made things *worse*: every
// edge touching a node converges on the same few fixed corners, so a busy
// node ends up with a pile-up of overlapping arrowheads there instead of a
// clean center attachment. This instead nudges each half of a real
// anti-parallel *pair*, after graphviz has already laid the graph out, into
// a gentle bow — the endpoints stay exactly where graphviz put them (the
// node's own default center-ish anchor), only the middle of the line moves,
// mirroring the natural curve graphviz's own obstacle-routing already gives
// *some* edges on these diagrams (any edge threading past a busy node is
// already bowed for exactly this reason, just not deliberately, and not for
// this one). The arrowhead is rotated to match the new approach angle —
// that's the correct look for a bent edge, not a compromise.
//
// No explicit left/right sign is passed in on purpose: the reverse edge of
// a pair runs the *same* physical line from the opposite end, so its own
// (dx,dy) — and therefore its own perpendicular — already point the other
// way of their own accord. An earlier version multiplied in an extra
// lexical-order-based sign on top of that and the two flips cancelled out,
// bowing both edges to the same side instead of apart (measured: identical
// control-point x within 0.4px of each other).

// Every node's own (id -> {w,h}) footprint in an already-rendered svg —
// shrinkNodesAndReconnectEdges's reference for "what size should this node
// actually be".
function parseNodeSizes(svg) {
  const sizes = new Map();
  const nodeRe = /<g id="([^"]+)" class="node[^"]*">([\s\S]*?)<\/g>/g;
  let m;
  while ((m = nodeRe.exec(svg))) {
    const xs = [], ys = [];
    for (const attrM of m[2].matchAll(/(?:points|d)="([^"]+)"/g)) {
      for (const cm of attrM[1].matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)) {
        xs.push(parseFloat(cm[1]));
        ys.push(parseFloat(cm[2]));
      }
    }
    if (!xs.length) continue;
    sizes.set(m[1], { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  }
  return sizes;
}

// Draws every node's shape back down toward its size in `naturalSvg` — a
// second render of the *same* graph at graphviz's own default margin — and
// retracts the one endpoint of every edge touching a shrunk node to match.
// The companion to build()'s oversized margin="0.6,0.4": that margin exists
// purely to give overlap-removal enough of a size difference to actually
// separate two touching nodes, not because the diagram is supposed to look
// like that.
//
// Shrinking to an exact per-node target (rather than subtracting a fixed pt
// amount from every node alike) matters because graphviz doesn't inflate
// every shape by the same amount for the same margin: a hexagon (periph) or
// cylinder (var) needs proportionally more headroom than a box to inscribe
// the same label once you account for their own shape geometry — measured:
// margin="0.6,0.4" grew a box ×1.34 in width but a hexagon ×1.58 and a
// cylinder ×1.72. A single formula can't undo that; comparing each node
// against its own natural-size twin can, exactly, however differently
// graphviz treats a shape.
function shrinkNodesAndReconnectEdges(svg, naturalSvg, growthFactor = 1) {
  const naturalSizes = parseNodeSizes(naturalSvg);

  const nodeRe = /<g id="([^"]+)" class="node[^"]*">[\s\S]*?<\/g>/g;
  const nodeBlocks = [];
  let m;
  while ((m = nodeRe.exec(svg))) nodeBlocks.push({ id: m[1], start: m.index, end: m.index + m[0].length, text: m[0] });

  // one scale-toward-center transform per node that actually needs shrinking
  // (never touches <text> — see below) — every edge endpoint touching that
  // node reuses the exact same transform, so the edge's tip lands exactly
  // where the shape's own new boundary ends up, not just close to it.
  const xf = new Map(); // node id -> { cx, cy, sx, sy }
  for (const nb of nodeBlocks) {
    const natural = naturalSizes.get(nb.id);
    if (!natural) continue; // wasn't in the reference render — leave alone
    const xs = [], ys = [];
    for (const attrM of nb.text.matchAll(/(?:points|d)="([^"]+)"/g)) {
      for (const cm of attrM[1].matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)) {
        xs.push(parseFloat(cm[1]));
        ys.push(parseFloat(cm[2]));
      }
    }
    if (!xs.length) continue;
    const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
    const w = x2 - x1, h = y2 - y1;
    if (w < 1 || h < 1) continue;
    // never grow a node past its inflated (margin) size, whatever
    // growthFactor asks for — never a license to reintroduce the overlap
    // the oversized margin was there to avoid.
    const sx = Math.min(1, (natural.w * growthFactor) / w);
    const sy = Math.min(1, (natural.h * growthFactor) / h);
    if (sx > 0.995 && sy > 0.995) continue;
    xf.set(nb.id, { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, sx, sy });
  }
  if (!xf.size) return svg;
  const apply = (t, px, py) => [t.cx + (px - t.cx) * t.sx, t.cy + (py - t.cy) * t.sy];

  let out = svg;
  // Shape only — never touch <text>. The label's own internal line spacing
  // was never inflated by the outer margin in the first place (only the
  // padding *around* the whole label block was), and it's already centered
  // on this same (cx,cy); scaling it down on top of that over-compresses
  // multi-line labels toward each other. Shrinking only the outer shape,
  // unmoved center, tightens it around the already-correctly-laid-out text
  // for free.
  for (let i = nodeBlocks.length - 1; i >= 0; i--) {
    const nb = nodeBlocks[i];
    const t = xf.get(nb.id);
    if (!t) continue;
    const shrunk = nb.text.replace(/((?:points|d)=")([^"]+)(")/g, (_, pre, coords, post) => {
      const nc = coords.replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_2, px, py) => {
        const [nx, ny] = apply(t, parseFloat(px), parseFloat(py));
        return `${nx.toFixed(2)},${ny.toFixed(2)}`;
      });
      return pre + nc + post;
    });
    out = out.slice(0, nb.start) + shrunk + out.slice(nb.end);
  }

  // Retract the one endpoint of every edge touching a shrunk node (using
  // that *same* node's transform, so the tip lands exactly on the shape's
  // new boundary) — without this, edges still reach for the old, bigger
  // boundary and hang visibly short of the now-smaller shape. Only the
  // first/last coordinate pair moves, never the interior of the spline, so a
  // long curved edge's overall route/shape is undisturbed — just its tip.
  const edgeRe = /<g id="[^"]*" class="edge[^"]*">[\s\S]*?<\/g>/g;
  const edgeBlocks = [];
  while ((m = edgeRe.exec(out))) edgeBlocks.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  for (let i = edgeBlocks.length - 1; i >= 0; i--) {
    const eb = edgeBlocks[i];
    const titleM = eb.text.match(/<title>([^<]+)<\/title>/);
    if (!titleM) continue;
    const parts = titleM[1].split('&#45;&gt;');
    if (parts.length !== 2) continue;
    const tFrom = xf.get(parts[0]), tTo = xf.get(parts[1]);
    if (!tFrom && !tTo) continue;
    let text = eb.text.replace(/(<path\b[^>]*\bd=")([^"]+)(")/, (_, pre, d, post) => {
      const coords = [...d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)];
      if (!coords.length) return pre + d + post;
      let nd = '', cursor = 0;
      coords.forEach((cm, idx) => {
        nd += d.slice(cursor, cm.index);
        let px = parseFloat(cm[1]), py = parseFloat(cm[2]);
        if (idx === 0 && tFrom) [px, py] = apply(tFrom, px, py);
        else if (idx === coords.length - 1 && tTo) [px, py] = apply(tTo, px, py);
        nd += `${px.toFixed(2)},${py.toFixed(2)}`;
        cursor = cm.index + cm[0].length;
      });
      nd += d.slice(cursor);
      return pre + nd + post;
    });
    // the arrowhead polygon always sits at the target end (every edge here
    // is dir=forward), so it moves with tTo, not tFrom.
    if (tTo) {
      text = text.replace(/(<polygon\b[^>]*\bpoints=")([^"]+)(")/, (_, pre, pts, post) => {
        const npts = pts.trim().split(/\s+/).map((p) => {
          const [px, py] = p.split(',').map(Number);
          const [nx, ny] = apply(tTo, px, py);
          return `${nx.toFixed(2)},${ny.toFixed(2)}`;
        }).join(' ');
        return pre + npts + post;
      });
    }
    out = out.slice(0, eb.start) + text + out.slice(eb.end);
  }

  return out;
}

// Start/end/control point for bending pathD's straight(ish) endpoint-to-
// endpoint line by `sign` (+1 or -1 — which of the two perpendicular sides
// to bow toward). Split out of bendOneEdge so chooseBendSign (below) can
// probe both candidate control points without touching any SVG text.
function bendControlPoint(pathD, sign) {
  const nums = pathD.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  const x1 = parseFloat(nums[0]), y1 = parseFloat(nums[1]);
  const x2 = parseFloat(nums[nums.length - 2]), y2 = parseFloat(nums[nums.length - 1]);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null; // coincident nodes — nothing sane to bend
  const bend = Math.min(18, len * 0.16) * sign;
  return { x1, y1, x2, y2, cx: (x1 + x2) / 2 + (-dy / len) * bend, cy: (y1 + y2) / 2 + (dx / len) * bend };
}

function bendOneEdge(pathD, body, sign = 1) {
  const pt = bendControlPoint(pathD, sign);
  if (!pt) return null;
  const { x1, y1, x2, y2, cx, cy } = pt;
  const newD = `M${x1.toFixed(2)},${y1.toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
  let out = body.replace(/(<path\b[^>]*\bd=")([^"]+)(")/, (_, pre, _old, post) => pre + newD + post);

  // rotate the arrowhead (if any — dir=none links have none) to match the
  // new tangent at the head: a quadratic bezier's tangent there points from
  // the control point straight to the endpoint.
  const polyM = out.match(/<polygon\b[^>]*\bpoints="([^"]+)"[^>]*\/>/);
  if (polyM) {
    const rot = Math.atan2(y2 - cy, x2 - cx) - Math.atan2(y2 - y1, x2 - x1);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const pts = polyM[1].trim().split(/\s+/).map(p => {
      const [px, py] = p.split(',').map(Number);
      const rx = px - x2, ry = py - y2;
      return `${(x2 + rx * cos - ry * sin).toFixed(2)},${(y2 + rx * sin + ry * cos).toFixed(2)}`;
    }).join(' ');
    out = out.replace(/(<polygon\b[^>]*\bpoints=")([^"]+)(")/, (_, pre, _old, post) => pre + pts + post);
  }

  // the label (if any) was placed by graphviz for the *straight* line —
  // shift it by the same offset the control point moved off the straight-
  // line midpoint, or it's left stranded where the line used to run instead
  // of following the curve it's actually sitting on now.
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
  const offX = cx - midX, offY = cy - midY;
  out = out.replace(/(<text\b[^>]*\bx=")([^"]+)("[^>]*\by=")([^"]+)(")/g, (_, pre1, xVal, mid, yVal, post) =>
    `${pre1}${(parseFloat(xVal) + offX).toFixed(2)}${mid}${(parseFloat(yVal) + offY).toFixed(2)}${post}`);

  return out;
}
// Every graph node's bounding box, keyed by its own id — the obstacle set
// chooseBendSign checks a candidate bend against. Reads every coordinate out
// of each node's own points="…"/d="…" attributes (covers box/hexagon's
// <polygon> and cylinder's <path> alike — this diagram never draws a node as
// <ellipse>), so it doesn't need to know each shape's own geometry rules.
function parseNodeBBoxes(svg) {
  const boxes = new Map();
  const nodeRe = /<g id="([^"]+)" class="node[^"]*">([\s\S]*?)<\/g>/g;
  let m;
  while ((m = nodeRe.exec(svg))) {
    const xs = [], ys = [];
    for (const attrM of m[2].matchAll(/(?:points|d)="([^"]+)"/g)) {
      for (const cm of attrM[1].matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)) {
        xs.push(parseFloat(cm[1]));
        ys.push(parseFloat(cm[2]));
      }
    }
    if (!xs.length) continue;
    boxes.set(m[1], { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) });
  }
  return boxes;
}
// 0 when (px,py) is inside/on box, else the distance out to its nearest edge.
function distToBox(px, py, box) {
  const dx = Math.max(box.x1 - px, 0, px - box.x2);
  const dy = Math.max(box.y1 - py, 0, py - box.y2);
  return Math.hypot(dx, dy);
}

// Anti-parallel edges (both directions between the same two nodes, e.g. a
// peripheral's register read edge and write edge) are meant to bow to
// *opposite* sides of the line joining the two nodes, giving a non-crossing
// "eye" shape. bendControlPoint's ±sign flips which side a SINGLE edge's own
// chord bows to — but the two directions' chords aren't exact mirror images
// of each other: each end attaches at a different point on its node's
// boundary (very visible on a hub node with many edges fanning out to
// distinct ports), so their (dx,dy) directions differ. Applying the *same*
// literal sign to both edges' own (differently-angled) formulas does not
// reliably land them on opposite sides of the A–B line — verified on real
// project data: the old shared-sign choice put both control points on the
// same side, producing an inward-crossing bow. The reference line must be
// the node-CENTER line, not either edge's own endpoint-to-endpoint chord —
// a hub node's edges attach at different boundary ports, so one edge's
// endpoints can sit entirely to one side of the other edge's own chord
// regardless of bend sign. Fixed by trying all 4 sign combinations, keeping
// only those where the two resulting control points fall on opposite sides
// of the node-center line, then using clearance-from-other-nodes to pick
// among the survivors.
function chooseBendSign(from, to, edgesByKey, nodeBoxes) {
  const eAB = edgesByKey.get(`${from}>${to}`);
  const eBA = edgesByKey.get(`${to}>${from}`);
  if (!eAB || !eBA) return { signAB: 1, signBA: 1 };
  const boxA = nodeBoxes.get(from), boxB = nodeBoxes.get(to);
  let rx1, ry1, rx2, ry2;
  if (boxA && boxB) {
    rx1 = (boxA.x1 + boxA.x2) / 2; ry1 = (boxA.y1 + boxA.y2) / 2;
    rx2 = (boxB.x1 + boxB.x2) / 2; ry2 = (boxB.y1 + boxB.y2) / 2;
  } else {
    const refP = bendControlPoint(eAB.pathD, 1);
    if (!refP) return { signAB: 1, signBA: 1 };
    ({ x1: rx1, y1: ry1, x2: rx2, y2: ry2 } = refP);
  }
  const side = (p) => (rx2 - rx1) * (p.cy - ry1) - (ry2 - ry1) * (p.cx - rx1);
  const others = [...nodeBoxes.entries()].filter(([id]) => id !== from && id !== to).map(([, box]) => box);

  let best = { signAB: 1, signBA: 1 }, bestClearance = -Infinity, foundOpposite = false;
  for (const signAB of [1, -1]) {
    const cAB = bendControlPoint(eAB.pathD, signAB);
    if (!cAB) continue;
    const sAB = side(cAB);
    for (const signBA of [1, -1]) {
      const cBA = bendControlPoint(eBA.pathD, signBA);
      if (!cBA) continue;
      const sBA = side(cBA);
      const opposite = (sAB >= 0) !== (sBA >= 0);
      if (foundOpposite && !opposite) continue; // once we have an opposite-sides candidate, only compete among those
      let clearance = others.length ? Infinity : 0;
      for (const box of others) {
        clearance = Math.min(clearance, distToBox(cAB.cx, cAB.cy, box), distToBox(cBA.cx, cBA.cy, box));
      }
      if (opposite && !foundOpposite) { foundOpposite = true; bestClearance = -Infinity; }
      if (clearance > bestClearance) { bestClearance = clearance; best = { signAB, signBA }; }
    }
  }
  return best;
}

function bendAntiParallelEdges(svg) {
  const groupRe = /<g id="[^"]*" class="edge[^"]*">[\s\S]*?<\/g>/g;
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
  const pairEdges = found.filter(e => pairKeys.has(`${e.to}>${e.from}`));
  if (!pairEdges.length) return svg;

  const edgesByKey = new Map(pairEdges.map(e => [`${e.from}>${e.to}`, e]));
  const nodeBoxes = parseNodeBBoxes(svg);
  const pairChoice = new Map(); // "A|B" (a<b) -> { signAB, signBA }, AB meaning a->b
  function signFor(a, b) {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const key = lo + '|' + hi;
    if (!pairChoice.has(key)) pairChoice.set(key, chooseBendSign(lo, hi, edgesByKey, nodeBoxes));
    const choice = pairChoice.get(key);
    return a === lo ? choice.signAB : choice.signBA;
  }

  let out = svg;
  // walk backwards so earlier splice offsets stay valid as later ones are rewritten
  for (let i = pairEdges.length - 1; i >= 0; i--) {
    const e = pairEdges[i];
    const bent = bendOneEdge(e.pathD, e.body, signFor(e.from, e.to));
    if (!bent) continue;
    out = out.slice(0, e.start) + bent + out.slice(e.end);
  }
  return out;
}
// plain call graph edge — dashed, control transfer rather than data
const dotCallEdge = (fromKey, toKey) => dotEdge(fnId(fromKey), fnId(toKey), { style: 'dashed' });
const dotExtCallEdge = (fromKey, name) => dotEdge(fnId(fromKey), extId(name), { style: 'dashed' });
// split rather than dir=both for the same reason as dotPeriphAccessEdges —
// a var that's both read and written gets its own write edge and read edge
function dotAccessEdges(fnKey, varKey, mode) {
  const a = fnId(fnKey), b = varId(varKey);
  if (mode === 'w') return [dotEdge(a, b)];
  if (mode === 'rw') return [dotEdge(a, b), dotEdge(b, a)];
  return [dotEdge(b, a)];
}

// node color is a CSS class (svg g.node.<class> in the page <style>, near
// CSS below) rather than baked into each node. The var tiers here are a
// notch more saturated than a first instinct would pick: "minor" only means
// "small/rare" across the whole program, but every var shown at level 0
// already cleared that bar (see showVars above), so a near-invisible
// gvarminor would misread as unimportant here.
//
// `dot` (rankdir=LR) was the first choice here, and it does route edges
// around unrelated nodes far better than ELK ever did — but it's still a
// *layered* algorithm like ELK, just with nicer splines: every node at the
// same graph-distance from an entry point lands in the same rank, i.e. the
// same straight column. On a real firmware-sized graph (a few entries, a
// couple dozen peripherals/var-bundles most of which sit one hop out) that
// reproduces exactly the "everything jammed into one strict line" problem
// this replaced ELK for in the first place. neato has no rank concept at
// all — springs settle wherever the connections pull them — which is what
// actually spreads peripherals/vars left/right instead of into a column
// (verified against a real ~80-function project before switching to it as
// the default). All three engines are cheap enough on a graph this size to
// render every one of them at build time instead of picking just one —
// viewer.js swaps the pre-built SVG instantly, no client-side re-layout.
const LEVEL0_ENGINES = ['neato', 'dot', 'fdp'];

// Hiding variables via the "переменные" checkbox used to just set
// display:none on the existing var nodes/edges, leaving the rest of the
// diagram exactly where graphviz put it — so the freed space just sat there
// as a hole instead of the function/peripheral nodes spreading out to use
// it. Rendering a *second*, fully independent layout with the var lines
// never included at all (not hidden after the fact) fixes that: the
// engine's own placement decisions are free to change once fewer nodes are
// competing for space. Both variants are cheap enough at build time to
// precompute for every engine, same reasoning as LEVEL0_ENGINES itself —
// so the checkbox, like the engine switcher, is an instant SVG swap in the
// browser, never a live re-layout.
//
// coreNodeLines/coreEdgeLines are the functions/peripherals/files that
// exist regardless of the toggle; varNodeLines/varEdgeLines are the
// variable and data-channel-bundle nodes and every edge touching one —
// entirely omitted from the "_novars" render rather than hidden in it.
async function renderDotAll(coreNodeLines, coreEdgeLines, varNodeLines = [], varEdgeLines = [], { rankdir = 'LR' } = {}) {
  const { Graphviz } = await import('@hpcc-js/wasm-graphviz');
  const graphviz = await Graphviz.load();
  const svgs = {};
  const hasVars = varNodeLines.length > 0;
  const MARGIN_NEATO = '0.6,0.4';
  // How far *back out* from the bare label-fit size (see
  // shrinkNodesAndReconnectEdges) the final, visible node ends up — bigger
  // nodes get a proportionally bigger main label too, rather than more empty
  // padding, same 14pt-default scaling the VS Code extension's node-size
  // control uses.
  const NODE_SCALE = 1.3;
  const FONT_SIZE = Math.round(14 * NODE_SCALE);
  const build = (nodeLines, edgeLines, engine, margin) => {
    const engineAttrs = engine === 'dot'
      ? `rankdir=${rankdir}, ranksep=0.6`
      : 'overlap=false, splines=true, sep="+12"';
    const nodeAttrs = (margin ? `, margin="${margin}"` : '') + `, fontsize=${FONT_SIZE}, penwidth=${NODE_SCALE}`;
    return ['digraph G {',
      `  graph [fontname="Segoe UI, Helvetica, sans-serif", nodesep=0.35, ${engineAttrs}];`,
      `  node [fontname="Segoe UI, Helvetica, sans-serif", style=filled, fillcolor=white${nodeAttrs}];`,
      `  edge [fontname="Segoe UI, Helvetica, sans-serif", fontsize=${Math.round(10 * NODE_SCALE)}, penwidth=${NODE_SCALE}];`,
      ...nodeLines, ...edgeLines, '}'].join('\n');
  };
  // A big margin here is a *layout* lever for the force-directed engines
  // (neato/fdp), not a visual one — shrinkNodesAndReconnectEdges draws the
  // actual shapes back down to their size in a *second*, default-margin
  // render of the same graph afterward (see that function's own comment for
  // why an exact per-node reference beats a one-size-fits-all shrink
  // formula). `sep` is ignored entirely by this build (verified: identical
  // 0-gap layout across a wide range of values); a *small* margin barely
  // moved node centers at all, but a large one gives overlap-removal enough
  // of a size difference to actually separate two touching nodes (confirmed
  // live: 0.16/0.3 did nothing, 0.6 did). dot never has an overlap problem
  // in the first place (rank-based, not force-directed), so it skips this
  // entirely.
  const renderOne = (nodeLines, edgeLines, engine) => {
    if (engine === 'dot') return graphviz.layout(build(nodeLines, edgeLines, engine, null), 'svg', engine);
    const bigSvg = graphviz.layout(build(nodeLines, edgeLines, engine, MARGIN_NEATO), 'svg', engine);
    const naturalSvg = graphviz.layout(build(nodeLines, edgeLines, engine, null), 'svg', engine);
    return shrinkNodesAndReconnectEdges(bigSvg, naturalSvg, NODE_SCALE);
  };
  for (const engine of LEVEL0_ENGINES) {
    svgs[engine] = renderOne([...coreNodeLines, ...varNodeLines], [...coreEdgeLines, ...varEdgeLines], engine);
    if (hasVars) {
      svgs[engine + '_novars'] = renderOne(coreNodeLines, coreEdgeLines, engine);
    }
  }
  // TEMPORARY: raw (unrendered) neato dot text, so the page can let the user
  // freely combine mode x model x seed client-side via graphviz-wasm.js
  // instead of us guessing which few combos to pre-bake — see
  // wireNeatoModeTester in viewer.js. Gated on an env var so normal builds
  // don't carry this; drop this line (and the matching HTML/JS) once done.
  const testRawDot = process.env.TEST_NEATO_MODES
    ? {
      withVars: build([...coreNodeLines, ...varNodeLines], [...coreEdgeLines, ...varEdgeLines], 'neato'),
      noVars: build(coreNodeLines, coreEdgeLines, 'neato'),
    }
    : undefined;
  return { svgs, hasVars, testRawDot };
}

// Level 0: entry points (main + ISRs), the peripherals they arm/drive, the
// hardware trigger back into ISRs, and the globals they exchange data
// through. Peripheral edges are solid for a write, dashed for a read
// (see dotPeriphAccessEdges); global-variable edges instead use solid/dashed
// for directly-in-the-entry's-own-body vs somewhere-down-its-call-tree (see
// dotAccessLink) — variables have no single "direction" of their own at this
// level (always written by one entry, read by another), so read/write isn't
// available as an encoding there the way it is for peripherals. Variables
// sharing the exact same set of writer/reader entry points are bundled into
// one collapsible "data channel" node instead of one node each, so a dozen
// buffers that all flow main -> DMA1_Channel2_IRQHandler read as a single
// thick edge instead of a dozen parallel ones.
// One entry's call-tree aggregation (which vars/peripherals/arms it reaches,
// and whether each is touched *directly* by the entry itself vs somewhere
// down the tree), seeded by seedFn(entry) — normally just the entry's own
// calls (the whole tree), but buildLevel0Diagram's "cyclic" variant instead
// seeds from just what runs inside the entry's own top-level infinite loop,
// to leave one-time boot/setup calls unvisited entirely. "direct" only ever
// means "the entry key itself", regardless of seeding — matches the original
// solid/dashed convention (dotAccessLink et al) untouched.
// includeOwnDirect(e) controls whether e's *own* body (not what it calls) is
// absorbed at all — always true for the plain "all"/"cyclic" aggregations
// (an entry's own direct code has always counted as part of it, regardless
// of loop-seeding, since day one of the cyclic filter). setupInfo needs it
// false for ISRs specifically: an ISR has no setup phase of its own (see
// buildLevel0Diagram), so *nothing* about it — not even its own body — may
// leak into the setup aggregation, or its own direct accesses would show up
// as "touched during both setup and runtime" (the overlap variant) purely
// because the same unconditional absorb ran in both aggregations.
function aggregateEntryInfo(entries, seedFn, includeOwnDirect = () => true) {
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
        // last absorbed write wins on a conflict (e.g. two setup paths
        // pointing the same channel at different buffers) — not modeled as
        // multiple candidates, just picks one deterministically; real
        // firmware only ever sets a channel's CPAR/CMAR from one place.
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

// Builds one Level 0 variant's node/edge lines from an aggregateEntryInfo()
// result — idPrefix keeps this variant's var-bundle ids (bnd_0, bnd_1, ...)
// from colliding with the *other* variant's when both sets of extraNodes get
// merged into one page (same bundle-count coincidence would otherwise mean
// two totally different variable lists sharing one id and one tooltip).
function assembleLevel0(entries, info, idPrefix, includeDma = false, dmaFacts = null) {
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

  const LEVEL0_MAX_UNITS = 50;
  let varCapNote = '';
  if (bundles.length > LEVEL0_MAX_UNITS) {
    const total = bundles.length;
    const bundleScore = b => b.vars.reduce((s, vk) => s + (varDefs.get(vk)?.score || 0), 0);
    bundles.sort((a, b) => bundleScore(b) - bundleScore(a));
    bundles = bundles.slice(0, LEVEL0_MAX_UNITS);
    varCapNote = `показаны ${LEVEL0_MAX_UNITS} самых используемых каналов данных из ${total}`;
  }

  // A peripheral earns a node purely by real register access now — arming it
  // (calling NVIC_EnableIRQ) is no longer enough on its own, now that arming
  // has its own honest home (the synthetic NVIC node, fed by periphInfo the
  // same as any real peripheral — see analyzeFunction's armCalls handling).
  // Dropped the armInfo-based addition here that used to pull a purely-armed
  // target peripheral onto the diagram even with zero register access
  // reachable anywhere (2026-07-16, "простая логика с включением периферии,
  // а не прерываниями").
  const usedPeriphs = new Set();
  for (const e of entries) {
    for (const pk of periphInfo.get(e.key).keys()) usedPeriphs.add(pk);
  }

  const LEVEL0_MAX_PERIPHS = 40;
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
  // *this* variant — e.g. an ISR that never runs during setup has nothing to
  // show on the "однократное" diagram at all, so it shouldn't sit there as a
  // disconnected box either. Populated below as edges are actually drawn,
  // then applied once at the end (dotFnNode lines are emitted after periph/
  // var/trigger edges now, not before).
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
    varNodeLines.push(dotVarNode(varDefs.get(b.vars[0]), { tiered: true }));
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
  // shared by every variant's DMA render — not recomputed from *this*
  // variant's own (possibly filtered) info, because the wiring is a hardware
  // fact about the channel, not "cyclic" vs "setup" runtime behavior: it's
  // normally poked once in dma_init, which the cyclic-only filtered variant
  // deliberately never reaches, and re-deriving it per variant used to mean
  // checking "DMA-потоки" while only "цикличное" was checked silently showed
  // nothing at all.
  let hasDma = false;
  if (includeDma) {
    const forcedDmaIds = new Set();
    // resolves a CPAR/CMAR ref to a node id, forcing a node onto the diagram
    // if the target isn't on it already — always the entity's own regular id
    // (periphId/varId), never a synthetic one, since graph-data.js already
    // carries full hover metadata (label, type, readers/writers, ...) for
    // *every* peripheral/var in the whole project, not just ones some
    // diagram happens to draw a node for — reusing the real id gets that
    // metadata for free. Pushed onto nodeLines (the core bucket) even for a
    // var, not varNodeLines — a DMA buffer should stay visible under
    // "DMA-потоки" regardless of the separate "переменные" toggle (user
    // request 2026-07-20: unchecking "переменные" was hiding DMA buffers
    // too, since they used to live in the same vars-gated bucket as the
    // normal cross-entry variable bundles). A var CMAR resolves to can never
    // also be a normal singleton/bundle var (dmaTargetVarKeys excludes it
    // from showVars above), so there's no duplicate node/edge case to guard
    // against here.
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
      if (!forcedDmaIds.has(id)) {
        nodeLines.push(dotVarNode(v, { tiered: true }));
        forcedDmaIds.add(id);
        // DMA hardware writes this buffer directly — the code itself never
        // assigns to it (a TX buffer only ever gets *read* out to the
        // peripheral; an RX buffer only ever gets *read* back by whoever
        // parses it), so it never earns the normal cross-entry "written by
        // one entry, read by a different one" filter (showVars) on its own.
        // Wired up here exactly like a normal singleton var (dotAccessLink),
        // so hovering it shows the functions that actually read/write it,
        // not just the DMA channel it's plumbed into — user request
        // 2026-07-20.
        for (const e of entries) {
          const a = varInfo.get(e.key)?.get(ref.key);
          if (!a) continue;
          edgeLines.push(dotAccessLink(e.key, id, a.direct, false));
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
      // point — see periphDirDetail's identical 'both' handling for enable
      // bits) means memory -> peripheral (TX); unset/absent is the STM32
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
// segment rather than after it — renderDotAll's own keys are "<engine>" /
// "<engine>_novars", and wireDiagramToolbar/setupEngineSwitchable build the
// combined key client-side as "<engine>_<variant>_novars", not
// "<engine>_novars_<variant>"
function withVariantSuffix(key, suffix) {
  return key.endsWith('_novars') ? key.slice(0, -'_novars'.length) + suffix + '_novars' : key + suffix;
}

// Every peripheral name / var key touched *anywhere* across all entries in
// an aggregateEntryInfo() result — the same union buildLevel0Diagram's
// usedPeriphs computes, but pulled out standalone so the cyclic/setup
// variants below can compare at the *whole-diagram* identity of a
// peripheral, not per-entry. Per-entry comparison was tried first and was
// wrong: a peripheral cyclically touched by one ISR and only-at-setup
// touched by main (two different entries) never shares a single entry key,
// so a per-entry "is this key present for the same entry in both maps" check
// never finds the overlap at all — it has to be asked at the level of "is
// this peripheral touched anywhere in each reachability set", independent of
// which entry did the touching.
// excludeOwnDirect skips anything only known through an entry's *own* inline
// code (a.direct) — used for the overlap computation in buildLevel0Diagram,
// where that inline code is the one thing that's identical evidence in both
// the cyclic and setup aggregations (analyzeFunction has no notion of "this
// statement is before vs inside the loop", only aggregateEntryInfo's seedFn
// distinguishes *calls* that way — see aggregateEntryInfo's own comment). A
// peripheral main pokes directly is never *provably* touched twice just
// because it shows up on both sides; only a genuinely separate cyclic-only
// callee and setup-only callee both touching it is real double-evidence.
// armInfo has no such distinction recorded at all (a plain Set, arm calls
// were never split direct-vs-indirect) — left unfiltered either way, since
// arming is near-always a true one-time setup fact rather than the source of
// false positives this guards against.
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
// peripherals/entries are otherwise on the diagram does that.
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

function usedNames(info, entries, includeIsrTriggers = false, excludeOwnDirect = false) {
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
  // firing an interrupt at all is itself cyclic/runtime behavior — a
  // peripheral that's *only* known through triggering an ISR (no direct
  // register access anywhere) still counts toward "cyclic" for the
  // exclusive/overlap set math below. (The diagram used to also draw a
  // visible "прерывание" trigger edge for this fact; that edge was dropped
  // per user request 2026-07-16 as redundant with the ISR's own name, but
  // the underlying fact still matters for this classification.)
  if (includeIsrTriggers) {
    for (const p of peripherals.values()) if (p.isrTargets.size) periphs.add(p.name);
  }
  return { periphs, vars };
}

// Rebuilds an aggregateEntryInfo()-shaped structure containing only the given
// peripheral names / var keys, merging entryA's and entryB's per-key values
// (r/w/direct flags, register maps, flag sets) wherever both happen to touch
// the same one — used for the overlap variant, where a peripheral's write
// might come from setup and its read from a cyclic path, and both facts are
// worth keeping rather than picking one side arbitrarily.
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
  // a peripheral allowed in purely for triggering an ISR (see usedNames'
  // includeIsrTriggers) has no periphInfo/armInfo entry anywhere above — it
  // was never actually *accessed*, just wired to an interrupt — so without
  // this it would never appear as a node at all (assembleLevel0 builds its
  // periphList from periphInfo/armInfo keys). A no-access placeholder on the
  // first entry is enough: assembleLevel0 doesn't care which entry key holds
  // it, only that the name is present in periphInfo *somewhere*.
  if (entries.length) {
    const anchor = periphInfo.get(entries[0].key);
    for (const name of allowedPeriphs) {
      const hasAny = [...periphInfo.values()].some(m => m.has(name)) || [...armInfo.values()].some(s => s.has(name));
      if (!hasAny) anchor.set(name, { r: false, w: false, direct: false });
    }
  }
  return { varInfo, periphInfo, periphFieldInfo, periphFlagInfo, periphAddrRefInfo, armInfo };
}

async function buildLevel0Diagram() {
  const entries = [...funcs.values()].filter(f => f.isEntry || f.isISR);
  if (entries.length === 0) return null;

  const allInfo = aggregateEntryInfo(entries, e => [...e.calls]);
  const all = assembleLevel0(entries, allInfo, 'a');
  const { svgs: rawSvgs, hasVars, testRawDot } = await renderDotAll(all.nodeLines, all.edgeLines, all.varNodeLines, all.varEdgeLines);
  const svgs = {};
  for (const [k, v] of Object.entries(rawSvgs)) {
    svgs[k] = injectPeriphDetailLabels(bendAntiParallelEdges(v), all.edgeDetails);
  }
  // Two independent seeds, each rendered as its own *inclusive* reachability
  // diagram — not as a set-difference against the other. An entry's own
  // directly-written body (e.g. main poking a register itself, not through a
  // helper call) has no loop/no-loop split at our granularity: analyzeFunction
  // only tracks loop-membership for *calls* (loopCallNames), never for
  // individual register accesses written inline. So main's own direct
  // accesses always land in both aggregations below identically — treating
  // "exactly one checkbox checked" as an exclusive set (cyclic-and-not-setup)
  // was tried and silently dropped every peripheral main touches directly,
  // since those can never be exclusive to either side. Rendering each seed's
  // full reachable set independently avoids that trap entirely.
  //
  // cyclic seed: entries whose own top-level infinite loop was found (see
  // findTopLevelInfiniteLoop) start from *just* that loop's own calls instead
  // of their whole call tree; an entry with no detected loop falls back to
  // its whole tree rather than silently vanishing. ISRs always use their
  // whole tree: an ISR firing at all *is* the cyclic/runtime behavior, it has
  // no "setup phase" of its own — so it never contributes to the setup seed.
  const cyclicInfo = aggregateEntryInfo(entries, e => (e.isISR ? [...e.calls] : (e.hasLoop ? [...e.loopCalls] : [...e.calls])));
  // setup seed: an entry's own direct calls that are *not* inside its loop —
  // exactly the one-time boot-phase calls (main's clock/GPIO/peripheral init).
  const setupInfo = aggregateEntryInfo(
    entries,
    e => (e.isISR ? [] : [...e.calls].filter(c => !e.loopCalls.has(c))),
    e => !e.isISR,
  );

  // "DMA-потоки" is a dedicated filter restricted to *cyclic* (runtime)
  // reachability, not all/setup — it used to include whatever touched a DMA
  // channel from *any* reachable code, which pulled main in via dma_init's
  // one-time CPAR/CMAR setup even though main itself never does anything
  // cyclic with the channel; that setup-only edge was the whole reason the
  // diagram needed a wiring fact in the first place, but showing main as a
  // full node alongside the ISRs "ломает вид" (user feedback 2026-07-20) —
  // main's *own* setup-time relationship to a channel isn't the interesting
  // runtime picture DMA-потоки is trying to show. dmaFacts itself (the
  // actual CPAR/CMAR wiring) still has to come from allInfo regardless —
  // dma_init is never cyclic-reachable, so that part of computeDmaFacts
  // would find nothing at all if it were restricted the same way — only
  // *which entries/peripherals count as connected* is restricted here, via
  // the same mergeFilteredInfo mechanism "overlap" below uses, sourced from
  // cyclicInfo instead of allInfo.
  const dmaFacts = computeDmaFacts(entries, allInfo);
  const dmaOnlyPeriphs = new Set(), dmaOnlyVars = new Set();
  for (const [channelName, refs] of dmaFacts.addrRefs) {
    dmaOnlyPeriphs.add(channelName);
    for (const ref of refs.values()) {
      if (ref.kind === 'periph') dmaOnlyPeriphs.add(ref.name);
      else dmaOnlyVars.add(ref.key);
    }
  }
  // off by default (no DMA usage anywhere in the project) so the checkbox
  // never shows at all — see dmaToggle in the return value below.
  let hasDma = false;
  let dmaOnly = null;
  if (dmaOnlyPeriphs.size) {
    hasDma = true;
    const dmaOnlyInfo = mergeFilteredInfo(entries, dmaOnlyPeriphs, dmaOnlyVars, cyclicInfo);
    dmaOnly = assembleLevel0(entries, dmaOnlyInfo, 'd', true, dmaFacts);
    const r = await renderDotAll(dmaOnly.nodeLines, dmaOnly.edgeLines, dmaOnly.varNodeLines, dmaOnly.varEdgeLines);
    for (const [k, val] of Object.entries(r.svgs)) {
      svgs[withVariantSuffix(k, '_dmaonly')] = injectPeriphDetailLabels(bendAntiParallelEdges(val), dmaOnly.edgeDetails);
    }
  }

  async function renderVariant(info, idPrefix, suffix) {
    const v = assembleLevel0(entries, info, idPrefix);
    const r = await renderDotAll(v.nodeLines, v.edgeLines, v.varNodeLines, v.varEdgeLines);
    for (const [k, val] of Object.entries(r.svgs)) {
      svgs[withVariantSuffix(k, suffix)] = injectPeriphDetailLabels(bendAntiParallelEdges(val), v.edgeDetails);
    }
    return { v, r };
  }

  const { v: cyclic, r: cyclicRender } = await renderVariant(cyclicInfo, 'c', '_cyclic');
  const { v: setupOnly, r: setupRender } = await renderVariant(setupInfo, 's', '_setuponly');

  // "neither checked" is the one case worth computing as a genuine
  // set relationship — peripherals/vars reachable from *both* seeds above,
  // i.e. touched during setup and again at runtime (e.g. a clock register
  // poked once at boot and again later). Compared at whole-diagram identity
  // (usedNames), not per-entry — the same peripheral is often cyclic-touched
  // by one entry (an ISR) and setup-touched by a completely different one
  // (main), so a per-entry check would never find the overlap.
  // excludeOwnDirect=true on both sides: an entry's own inline code (main
  // poking a register directly, not through a helper) is identical evidence
  // in *both* aggregations regardless of when it actually ran (see usedNames'
  // own comment) — without this, virtually everything main touches directly
  // ends up flagged "overlap" purely from that ambiguity, not because it was
  // provably touched at both setup and runtime.
  const cyclicUsed = usedNames(cyclicInfo, entries, true, true);
  const setupUsed = usedNames(setupInfo, entries, false, true);
  const overlapPeriphs = new Set([...cyclicUsed.periphs].filter(n => setupUsed.periphs.has(n)));
  const overlapVars = new Set([...cyclicUsed.vars].filter(n => setupUsed.vars.has(n)));
  const overlapInfo = mergeFilteredInfo(entries, overlapPeriphs, overlapVars, cyclicInfo, setupInfo);
  const { v: overlap, r: overlapRender } = await renderVariant(overlapInfo, 'o', '_overlap');

  // TEMPORARY: same shape either way ({withVars, noVars}), just split four
  // ways now — see wireNeatoModeTester in viewer.js, which reads both
  // checkboxes to pick the right one of these variants.
  const combinedTestRawDot = testRawDot
    ? { all: testRawDot, cyclic: cyclicRender.testRawDot, setuponly: setupRender.testRawDot, overlap: overlapRender.testRawDot }
    : undefined;

  return {
    svgs,
    varsToggle: hasVars,
    dmaToggle: hasDma,
    cyclicToggle: entries.some(e => e.isISR || e.hasLoop),
    note: [all.note, cyclic.note, setupOnly.note, overlap.note].filter(Boolean).join('; '),
    extraNodes: {
      ...all.extraNodes, ...cyclic.extraNodes, ...setupOnly.extraNodes, ...overlap.extraNodes,
      ...(dmaOnly ? dmaOnly.extraNodes : {}),
    },
    testRawDot: combinedTestRawDot,
  };
}

async function buildFunctionDiagram(fn) {
  const nodeLines = [dotFnNode(fn, { focus: true })];
  const edgeLines = [];
  const shown = new Set([fn.key]);

  for (const c of fn.callers) {
    const caller = funcs.get(c);
    if (!caller || shown.has(c)) continue;
    shown.add(c);
    nodeLines.push(dotFnNode(caller, { withFile: caller.file !== fn.file }));
    edgeLines.push(dotCallEdge(c, fn.key));
  }
  for (const calleeKey of fn.calls) {
    const callee = funcs.get(calleeKey);
    if (!callee) continue;
    if (!shown.has(calleeKey)) {
      shown.add(calleeKey);
      nodeLines.push(dotFnNode(callee, { withFile: callee.file !== fn.file }));
    }
    edgeLines.push(dotCallEdge(fn.key, calleeKey));
  }
  for (const ec of fn.extCalls) {
    nodeLines.push(dotExtNode(ec));
    edgeLines.push(dotExtCallEdge(fn.key, ec));
  }
  const varNodeLines = [];
  const varEdgeLines = [];
  for (const [varKey, mode] of fn.access) {
    const v = varDefs.get(varKey);
    if (!v) continue;
    varNodeLines.push(dotVarNode(v, { withFile: v.file !== fn.file }));
    varEdgeLines.push(...dotAccessEdges(fn.key, varKey, mode));
  }
  // peripherals this function touches directly, with the specific registers
  // on the edge — grouped with the variables (both are data access, both ride
  // the "переменные" toggle) rather than the call nodes. No longer unioned
  // with fn.arms (2026-07-16): a peripheral this function only arms via
  // NVIC_EnableIRQ, with no register access of its own, now shows up via its
  // edge to the synthetic NVIC node instead (NVIC itself already appears
  // here through fn.periphFields, same as any real peripheral — see
  // analyzeFunction's armCalls handling) — unioning fn.arms in on top of that
  // would draw an orphaned peripheral node with zero edges, now that
  // dotPeriphAccessEdges no longer draws anything for arm-only evidence.
  const periphNames = new Set(fn.periphFields.keys());
  const edgeDetails = [];
  for (const pName of periphNames) {
    varNodeLines.push(dotPeriphRelNode(pName));
    const { lines, details } = dotPeriphAccessEdges(
      fn.key, pName, fn.periphFields.get(pName), fn.periphFlags.get(pName), 'fn');
    varEdgeLines.push(...lines);
    edgeDetails.push(...details);
  }
  const { svgs: rawSvgs, hasVars } = await renderDotAll(nodeLines, edgeLines, varNodeLines, varEdgeLines);
  const svgs = {};
  for (const [k, v] of Object.entries(rawSvgs)) svgs[k] = injectPeriphDetailLabels(bendAntiParallelEdges(v), edgeDetails);
  // neato, not dot: the client-side chain-expansion in viewer.js pins
  // already-visible nodes at their current coordinates on every re-layout
  // (via pos="x,y!") so clicking one more hop doesn't reshuffle everything
  // already on screen — dot's rank-based algorithm has no such notion (every
  // node's column is reassigned from scratch), only neato/fdp respect a
  // pinned starting position. Matching the *initial* engine to neato too
  // means the very first click doesn't jump between two unrelated layout
  // styles.
  return { svgs, defaultEngine: 'neato', varsToggle: hasVars };
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
  .diagram-wrap { position: relative; }
  .diagram { background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; overflow: hidden; position: relative;
    max-height: 78vh; user-select: none; -webkit-user-select: none; outline: none; }
  .diagram .inner { transform-origin: 0 0; width: max-content; padding: 12px; }
  .zoombar { position: sticky; top: 6px; left: 6px; z-index: 5; display: inline-flex; gap: 4px; margin: 6px; }
  .zoombar button { border: 1px solid #d4d4d8; background: #fff; border-radius: 6px; width: 30px; height: 30px; cursor: pointer; font-size: 15px; }
  .zoombar button:hover { background: #f4f4f5; }
  /* lives outside .diagram (sibling in .diagram-wrap), positioned relative to
     the wrap's own box — independent of the diagram's own scroll/zoom state,
     since a scaled-down .inner doesn't shrink .diagram's scrollable extent.
     Scoped to a direct child of .diagram-wrap: a level-0 diagram's maxbtn
     sits inside .diagram-toolbar instead (next rule), which positions itself
     the same way and lets flexbox place the button within it. */
  .diagram-wrap > .maxbtn { position: absolute; bottom: 6px; right: 6px; z-index: 6; }
  .maxbtn { border: 1px solid #d4d4d8; background: #fff; border-radius: 6px; width: 30px; height: 30px;
    cursor: pointer; font-size: 15px; transition: transform .15s; }
  .maxbtn:hover { background: #f4f4f5; }
  .maxbtn.active { transform: rotate(180deg); }
  .diagram-toolbar { position: absolute; bottom: 6px; right: 6px; z-index: 6;
    display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,.9);
    padding: 4px 8px; border-radius: 6px; border: 1px solid #d4d4d8; font-size: 0.82em; }
  .diagram-toolbar select { border: 1px solid #d4d4d8; border-radius: 4px; font-size: 0.95em; }
  .gv-ctrl { display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
  .gv-ctrl:has(input:disabled) { opacity: 0.45; cursor: default; }
  .diagram.maximized { position: fixed; inset: 0; z-index: 1000; max-height: none;
    width: 100vw; height: 100vh; border-radius: 0; }
  .diagram-wrap:has(.diagram.maximized) .maxbtn,
  .diagram-wrap:has(.diagram.maximized) .diagram-toolbar { position: fixed; z-index: 1001; }
  body.diagram-maximized { overflow: hidden; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 16px; font-size: 0.85rem; color: #52525b; align-items: center; }
  .chip { display: inline-block; width: 14px; height: 14px; border-radius: 4px; vertical-align: -2px; margin-right: 5px; border: 1.5px solid; }
  table { border-collapse: collapse; margin-top: 8px; font-size: 0.9rem; }
  th, td { border: 1px solid #e4e4e7; padding: 5px 12px; text-align: left; }
  th { background: #f4f4f5; }
  td a { color: #2563eb; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .muted { color: #a1a1aa; }
  details summary { cursor: pointer; font-size: 1.1rem; font-weight: 600; margin-top: 2em; }
  .tip { position: fixed; z-index: 1100; max-width: 420px; background: #1e293b; color: #f1f5f9;
    padding: 8px 12px; border-radius: 8px; font-size: 12.5px; pointer-events: none;
    display: none; line-height: 1.5; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
  .tip .k { opacity: .65; font-size: 11.5px; }
  .tip .sig { font-family: Consolas, monospace; font-size: 11.5px; color: #93c5fd; margin: 2px 0; }
  .tip .d { margin-top: 4px; }
  svg g.node { transition: opacity .13s; cursor: pointer; }
  svg.fade g.node { opacity: .13; }
  svg.fade .hl { opacity: 1 !important; }
  /* hover ring: for the "Связи" diagram, where .hl already marks the
     permanently-confirmed chain (see setupRelationsDiagram in viewer.js) — an
     already-full-color node/edge has no opacity left to restore on hover, so
     it gets a glow instead, the same way a dimmed one gets its color back. */
  svg g.node.hlring path, svg g.node.hlring polygon, svg g.node.hlring ellipse
    { filter: drop-shadow(0 0 4px #2563eb) drop-shadow(0 0 4px #2563eb); }
  svg g.edge.hlring path { filter: drop-shadow(0 0 3px #2563eb); }
  .diagram.panning { cursor: grabbing; }
  .diagram.panning svg g.node { cursor: grabbing; }
  .diagram.loading { cursor: wait; }
  .diagram.loading .inner { opacity: .6; transition: opacity .15s; }
  /* node color is a CSS class rather than baked into the SVG's fill/stroke
     directly, so the whole palette lives in one place. Any shape tag
     graphviz might use for a class (polygon for box/hexagon, path for
     cylinder, ellipse for CFG start/end) is covered. */
  .diagram[data-engine="graphviz"] svg g.node.fn path,
  .diagram[data-engine="graphviz"] svg g.node.fn polygon { fill: #dbeafe; stroke: #2563eb; }
  .diagram[data-engine="graphviz"] svg g.node.entry path,
  .diagram[data-engine="graphviz"] svg g.node.entry polygon { fill: #dcfce7; stroke: #16a34a; }
  .diagram[data-engine="graphviz"] svg g.node.isr path,
  .diagram[data-engine="graphviz"] svg g.node.isr polygon { fill: #fee2e2; stroke: #dc2626; }
  .diagram[data-engine="graphviz"] svg g.node.periph path,
  .diagram[data-engine="graphviz"] svg g.node.periph polygon { fill: #e0e7ff; stroke: #4338ca; }
  .diagram[data-engine="graphviz"] svg g.node.periphhot path,
  .diagram[data-engine="graphviz"] svg g.node.periphhot polygon { fill: #c7d2fe; stroke: #3730a3; stroke-width: 2px; }
  .diagram[data-engine="graphviz"] svg g.node.gvar path,
  .diagram[data-engine="graphviz"] svg g.node.gvar polygon { fill: #fcd34d; stroke: #b45309; }
  .diagram[data-engine="graphviz"] svg g.node.gvarhot path,
  .diagram[data-engine="graphviz"] svg g.node.gvarhot polygon { fill: #f59e0b; stroke: #92400e; stroke-width: 2px; }
  /* "minor" here just means "smaller bundle", not "unimportant" (every var
     shown already matters enough to cross entry points/files), so it stays
     legible rather than fading toward invisible the way a low-importance
     tier normally would. */
  .diagram[data-engine="graphviz"] svg g.node.gvarminor path,
  .diagram[data-engine="graphviz"] svg g.node.gvarminor polygon { fill: #fde68a; stroke: #ca8a04; }
  .diagram[data-engine="graphviz"] svg g.node.ghost path,
  .diagram[data-engine="graphviz"] svg g.node.ghost polygon { fill: #f4f4f5; stroke: #a1a1aa; }
  .diagram[data-engine="graphviz"] svg g.node.cfgstmt polygon { fill: #f8fafc; stroke: #94a3b8; }
  .diagram[data-engine="graphviz"] svg g.node.cfgcall polygon { fill: #dbeafe; stroke: #2563eb; }
  .diagram[data-engine="graphviz"] svg g.node.cfgcond polygon { fill: #fef3c7; stroke: #d97706; }
  .diagram[data-engine="graphviz"] svg g.node.cfgterm ellipse { fill: #e2e8f0; stroke: #64748b; }
  .diagram[data-engine="graphviz"] svg g.node.cfgjump ellipse { fill: #fce7f3; stroke: #db2777; }
  svg g.edge, svg g.edge * { transition: opacity .13s; }
  svg.fade g.edge { opacity: .13; }
  svg.fade g.edge.hl { opacity: 1 !important; }
  svg g.edge.hl path { stroke-width: 2.5px !important; }
  svg g.edge.hl polygon { stroke-width: 2.5px !important; }
  /* register-access labels (e.g. "CCR: запись") only earn their keep once
     that specific edge is actually highlighted — at rest, every peripheral's
     incoming edges showing their register list at once was the whole
     diagram's worth of text cluttering it permanently. Graphviz still lays
     the label out (reserves its space / routes the edge around it), this
     only ever hides the rendered text, so nothing reflows on hover. */
  svg g.edge > text { opacity: 0; }
  svg g.edge.hl > text { opacity: 1 !important; }
  /* "_EN" (see dotPeriphAccessEdges) is the one edge-label exception to
     the hide-by-default rule above — a short, static hint some periph edges
     (ones touching an "enable"-shaped bit, or a direct NVIC_EnableIRQ arm)
     carry even at rest. It steps aside for its own .periph-detail siblings
     (the full register/flag breakdown, still governed by the plain rules
     above) only while the edge itself is actually highlighted. */
  svg g.edge > text.periph-default { opacity: 1; }
  svg g.edge.hl > text.periph-default { opacity: 0 !important; }
  /* CFG "Алгоритм" diagrams (cfg_*) only ever draw plain control-flow labels
     (да/нет/case values) — never periph register-access clutter — so the
     hide-until-hover rule above doesn't apply to them. */
  .diagram[data-diagram-id^="cfg_"] svg g.edge > text { opacity: 1; }
  .trailbar { font-size: 0.85rem; color: #52525b; margin: 0 0 14px; }
  .trailbar a { color: #2563eb; text-decoration: none; }
  .trailbar a:hover { text-decoration: underline; }
  .trailbar .sep { margin: 0 6px; color: #a1a1aa; }
  .trailbar .cur { color: #18181b; font-weight: 600; }
`;

const LEGEND = `
<div class="legend">
  <span>функция <b>&rarr;</b> переменная = <b>запись</b></span>
  <span>переменная <b>&rarr;</b> функция = <b>чтение</b></span>
  <span><b>&harr;</b> = чтение + запись</span>
  <span><b>&#8943;&gt;</b> (пунктир) = вызов, передача управления</span>
  <span><span class="chip" style="background:#f4f4f5;border-color:#a1a1aa;border-style:dashed"></span>из другого файла / внешнее</span>
  <span class="muted">наведите курсор — подсветятся связи; клик — закрепить подсветку; двойной клик — перейти; клик по пустому месту — снять</span>
</div>`;

const LEGEND0 = `
<div class="legend">
  <span>точка входа <b>&mdash;</b> переменная — связь без стрелки: эти данные всегда идут в обе стороны между разными точками входа (иначе переменная не попала бы на этот уровень), указывать направление незачем</span>
  <span>точка входа <b>&rarr;</b> периферия, <b>сплошная</b> линия = <b>запись</b>; периферия <b>&rarr;</b> точка входа, <b>пунктирная</b> линия = <b>чтение</b>; обе стрелки сразу = и то, и другое</span>
  <span>для переменных стрелок нет (см. выше), но сплошная/пунктирная сохраняет старый смысл: точка входа обращается сама (в своём теле) / где-то внутри функций, которые она вызывает</span>
  <span><span class="chip" style="background:#e0e7ff;border-color:#4338ca"></span>&#11039; периферия (регистры вида <code>X-&gt;поле</code>)</span>
  <span><b>&rarr;</b> «<i>РЕГИСТР</i>_EN» (например «CCR_EN») — та же сплошная (запись) стрелка, когда включается конкретный бит; голое «_EN» — включение только вызовом NVIC_EnableIRQ, без своего регистра; «~ИМЯ» (например «~CCR_EN») в подробностях по наведению — бит только выключается здесь, нигде не включается</span>
  <span>цилиндр с несколькими именами — переменные, связанные с одним и тем же набором точек входа, собранные в один жгут</span>
  <span><span class="chip" style="background:#fff;border-color:#0d9488;border-style:dashed"></span>чекбокс «DMA-потоки» (доступен только при включённом «цикличное») — отдельный вид: только каналы DMA, куда/откуда они пишут (CPAR/CMAR, направление по биту DIR) и точки входа, которые касаются их в цикличном поведении — без точек входа, связанных только через однократную настройку</span>
  <span class="muted">наведите курсор — подсветятся связи; клик — закрепить подсветку; двойной клик — перейти; клик по пустому месту — снять</span>
</div>`;

function htmlPage({ title, rel, path, body, cfgLinks, extraNodes }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<script>
window.PAGE_REL = ${JSON.stringify(rel)};
window.PAGE_PATH = ${JSON.stringify(path)};
window.PAGE_TITLE = ${JSON.stringify(title)};
${cfgLinks ? `window.CFG_LINKS = ${JSON.stringify(cfgLinks)};` : ''}
${extraNodes ? `window.PAGE_EXTRA_NODES = ${JSON.stringify(extraNodes)};` : ''}
</script>
<nav><span class="title">code graph</span><a href="${rel}index.html">обзор</a></nav>
<main>
${body}
</main>
<script src="${rel}graph-data.js"></script>
<script src="${rel}app.js"></script>
</body>
</html>`;
}

// Every diagram ships as already-laid-out SVGs — one per engine — computed
// at build time, not in the browser (see setupGraphvizSvg in viewer.js for
// the hover/click wiring). Only the default engine's SVG is inlined into
// .inner; the rest ride along in a hidden JSON
// blob so switching engines in the browser is an instant DOM swap, not a
// re-render (see setupEngineSwitchable in viewer.js). Engine/vars controls
// live in a toolbar next to this diagram's own maximize button (not the
// page-wide nav) since they're properties of this one diagram, not a
// page-wide setting; varsToggle is only worth showing on diagrams that
// actually mix in variable nodes (not aggregate/include, which are file-only).
function diagramBlockSvg(svgs, { defaultEngine = 'neato', varsToggle = true, cyclicToggle = false, dmaToggle = false, diagramId = 'gv', focus, testRawDot } = {}) {
  return `<div class="diagram-wrap">
<div class="diagram" data-engine="graphviz" data-cur-engine="${defaultEngine}" data-diagram-id="${diagramId}"${focus ? ` data-focus="${focus}"` : ''} tabindex="-1">
<div class="zoombar">
  <button onclick="zoom(this, 1.25)">+</button>
  <button onclick="zoom(this, 0.8)">&minus;</button>
</div>
<div class="inner">${svgs[defaultEngine]}</div>
<script type="application/json" class="engine-data">${JSON.stringify(svgs)}</script>
${testRawDot ? `<script type="application/json" class="test-raw-dot">${JSON.stringify(testRawDot)}</script>` : ''}
</div>
<div class="diagram-toolbar">
${varsToggle ? '  <label class="gv-ctrl"><input type="checkbox" class="gv-vars-toggle" checked> переменные</label>\n' : ''}${cyclicToggle ? `  <label class="gv-ctrl"><input type="checkbox" class="gv-cyclic-toggle" checked> цикличное</label>
  <label class="gv-ctrl"><input type="checkbox" class="gv-setup-toggle" checked> однократное</label>\n` : ''}${dmaToggle ? '  <label class="gv-ctrl"><input type="checkbox" class="gv-dma-toggle"> DMA-потоки</label>\n' : ''}  <select class="gv-engine-select">
    <option value="neato"${defaultEngine === 'neato' ? ' selected' : ''}>органично</option>
    <option value="dot"${defaultEngine === 'dot' ? ' selected' : ''}>иерархично</option>
    <option value="fdp"${defaultEngine === 'fdp' ? ' selected' : ''}>силовое</option>
  </select>
${testRawDot ? `  <label class="gv-ctrl">mode <select class="test-mode-select">
    <option value="">(default)</option>
    <option value="KK">KK</option>
    <option value="major">major</option>
    <option value="hier">hier</option>
    <option value="ipsep">ipsep</option>
  </select></label>
  <label class="gv-ctrl">model <select class="test-model-select">
    <option value="">(default)</option>
    <option value="shortpath">shortpath</option>
    <option value="circuit">circuit</option>
    <option value="mds">mds</option>
  </select></label>
  <label class="gv-ctrl">seed <input type="number" class="test-seed-input" value="0" min="0" max="999" style="width:4em"></label>
  <label class="gv-ctrl">len <input type="number" class="test-len-input" value="3.5" min="0.5" max="10" step="0.5" style="width:4em"></label>` : ''}
  <button class="maxbtn" onclick="toggleMaximize(this)" title="На весь экран (F)">&#9974;</button>
</div>
</div>`;
}

// --- write output tree ---

const filesDir = path.join(outDir, 'files');
const funcsDir = path.join(outDir, 'functions');
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(funcsDir, { recursive: true });

const here = path.dirname(fileURLToPath(import.meta.url));
fs.copyFileSync(path.join(here, 'viewer.js'), path.join(outDir, 'app.js'));

// graphviz-wasm.js: the same @hpcc-js/wasm-graphviz build index.mjs itself
// uses, re-exported as a classic (non-module) script so viewer.js can load
// it with a plain <script src> — a real `import`/`type=module` fetch of a
// package from node_modules gets refused by Chrome on file:// pages (this
// tool's normal way of being opened, no server), which is why this can't
// just be a copy like app.js above. The wasm binary itself is embedded
// inline in this file (no separate .wasm fetch), so once loaded it works
// fully offline. Used by the function-page "Связи" diagram to lay out
// caller/callee chains the user expands by clicking — see setupRelationsDiagram
// in viewer.js.
{
  const src = fs.readFileSync(
    path.join(here, 'node_modules', '@hpcc-js', 'wasm-graphviz', 'dist', 'index.js'), 'utf-8');
  const re = /export\{(\w+) as Graph,(\w+) as Graphviz,(\w+) as Subgraph\};/;
  const m = src.match(re);
  if (!m) throw new Error('graphviz-wasm.js: could not find the expected export{...} tail — package layout changed?');
  const classic = src.slice(0, m.index) +
    `globalThis.GraphvizWasm={Graph:${m[1]},Graphviz:${m[2]},Subgraph:${m[3]}};`;
  fs.writeFileSync(path.join(outDir, 'graphviz-wasm.js'), classic);
}

// graph-data.js: node info for hover tooltips on every page
{
  const nodes = {};
  const fnName = k => funcs.get(k)?.name || k;
  for (const fn of funcs.values()) {
    nodes[fnId(fn.key)] = {
      label: fn.name, kind: fn.isISR ? 'isr' : fn.isEntry ? 'entry' : 'fn',
      file: fn.file, sig: fn.signature, desc: fn.desc || undefined,
      href: `functions/${pageName(fn.key)}.html`,
      // caller/callee ids + accessed-var ids, in the same "svg element id"
      // namespace as everything else here — lets the client walk the call
      // graph arbitrarily deep (e.g. the function-page relations diagram's
      // click-to-expand-a-chain feature) without a page reload, by feeding
      // freshly-built dot text through graphviz-wasm.js. Only populated for
      // real (in-codebase) functions, not extfn/isr distinguishing needed.
      calls: [...fn.calls].map(fnId),
      callers: [...fn.callers].map(fnId),
      access: [...fn.access.entries()].map(([vk, mode]) => ({ v: varId(vk), mode })),
      // peripherals touched directly, with per-register (and, where a named
      // bit was found, per-bit) detail — lets the client rebuild the "Связи"
      // diagram with the same access edge and hover-reveal the build-time SVG
      // uses (see dotPeriphRelNode/dotPeriphAccessEdges). No longer unioned
      // with fn.arms (2026-07-16) — arming shows up through the synthetic
      // NVIC peripheral's own periphFields entry instead, same as any real
      // peripheral (see analyzeFunction's armCalls handling), not as a
      // special addendum here.
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
      nodes[extId(ec)] = nodes[extId(ec)] || { label: ec, kind: 'extfn' };
    }
  }
  for (const v of varDefs.values()) {
    nodes[varId(v.key)] = {
      label: v.name,
      kind: v.isExternal ? 'extvar' : v.isVolatile ? 'gvolatile' : 'gvar',
      file: v.file || undefined, type: v.typeText || undefined,
      static: v.isStatic || undefined, volatile: v.isVolatile || undefined,
      desc: v.desc || undefined, users: v.users || undefined,
      writers: [...v.writers].map(fnName), readers: [...v.readers].map(fnName),
      href: v.file ? `files/${sanitize(v.file)}.html` : undefined,
    };
  }
  for (const f of fileRecords) {
    nodes[`file_${sanitize(f.basename)}`] = {
      label: f.basename, kind: 'file', desc: f.filePath,
      href: `files/${sanitize(f.basename)}.html`,
    };
  }
  for (const p of peripherals.values()) {
    nodes[periphId(p.name)] = {
      label: p.name, kind: 'periph',
      writers: [...p.writers].map(fnName), readers: [...p.readers].map(fnName),
      armers: [...p.armers].map(fnName), isrTargets: [...p.isrTargets].map(fnName),
    };
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

  const varRows = [...varDefs.values()]
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name)).map(v => {
    const users = keys => [...keys].map(k =>
      `<a href="functions/${pageName(k)}.html">${escapeHtml(funcs.get(k)?.name || k)}</a>`).join(', ') || '<span class="muted">—</span>';
    return `<tr><td>${escapeHtml(v.name)}${v.isVolatile ? ' <b style="color:#dc2626">volatile</b>' : ''}${v.isStatic ? ' <span class="muted">static</span>' : ''}</td>` +
      `<td class="muted">${escapeHtml(v.typeText)}</td>` +
      `<td>${escapeHtml(v.desc || '')}</td>` +
      `<td>${v.file ? `<a href="files/${sanitize(v.file)}.html">${escapeHtml(v.file)}</a>` : '<span class="muted">внешняя</span>'}</td>` +
      `<td>${v.users}</td>` +
      `<td>${users(v.writers)}</td><td>${users(v.readers)}</td></tr>`;
  }).join('\n');

  const level0 = await buildLevel0Diagram();
  const level0Diagram = level0
    ? diagramBlockSvg(level0.svgs, { diagramId: 'level0', varsToggle: level0.varsToggle, cyclicToggle: level0.cyclicToggle, dmaToggle: level0.dmaToggle, testRawDot: level0.testRawDot })
    : '';
  const overview = await buildOverviewDiagram();
  const overviewDiagram = diagramBlockSvg(overview.svgs, { diagramId: 'overview', varsToggle: overview.varsToggle });
  const include = await buildIncludeDiagram();
  const includeDiagram = diagramBlockSvg(include.svgs,
    { diagramId: 'include', varsToggle: false, defaultEngine: include.defaultEngine || 'neato' });
  const body = `
<h1>Обзор программы</h1>
<p class="muted">Источник: ${roots.map(r => escapeHtml(path.resolve(r))).join(', ')} —
файлов: ${fileRecords.length}, функций: ${funcs.size}, глобальных переменных: ${varDefs.size}</p>
${LEGEND}
${level0 ? `
<h2>Уровень 0 — точки входа, периферия и обмен данными</h2>
<p class="muted">main и обработчики прерываний; шестиугольники — периферия (регистровые блоки вида <code>X-&gt;поле</code>),
серые блоки — переменные с одинаковыми писателями/читателями, свёрнутые в один жгут (клик разворачивает).
Периферия: сплошная стрелка (точка входа &rarr; периферия) = запись, пунктирная (периферия &rarr; точка входа) = чтение;
подпись вида «CCR_EN» на сплошной стрелке — включение конкретного бита в этом регистре; голое «_EN» — включение только вызовом NVIC_EnableIRQ, без своего регистра.
Для переменных сплошная/пунктирная линия значит другое: точка входа обращается сама / где-то внутри её вызовов.
Двойной клик по функции — спуск на уровень ниже (связи + блок-схема алгоритма).${level0.note ? ` Здесь ${level0.note}.` : ''}</p>
${LEGEND0}
${level0Diagram}

<details>
<summary>Полная карта — все функции и переменные</summary>
<p class="muted">Яркие крупные переменные — «шины» программы (много читателей/писателей, часто из разных файлов);
бледные — используются одной функцией. Колесо мыши — масштаб, зажатая левая кнопка на пустом месте — перетаскивание.</p>
${overviewDiagram}
</details>` : overviewDiagram}

<details>
<summary>Граф include (файлы)</summary>
${includeDiagram}
</details>

<h2>Файлы</h2>
<table><tr><th>Файл</th><th>Путь</th><th>Функций</th><th>Глобалов</th></tr>${fileRows}</table>

<h2>Функции</h2>
<table><tr><th>Функция</th><th>Описание</th><th>Файл</th><th>Вызывается</th><th>Вызывает</th><th>Глобалов</th></tr>${funcRows}</table>

<h2>Глобальные переменные <span class="muted" style="font-weight:400;font-size:0.75em">— по убыванию использования</span></h2>
<table><tr><th>Переменная</th><th>Тип</th><th>Описание</th><th>Определена в</th><th>Функций</th><th>Пишут</th><th>Читают</th></tr>${varRows}</table>`;

  fs.writeFileSync(path.join(outDir, 'index.html'),
    htmlPage({ title: 'Код-граф — обзор', rel: '', path: 'index.html', body, extraNodes: level0 ? level0.extraNodes : undefined }));
}

// per-file pages
for (const f of fileRecords) {
  const fnsHere = [...funcs.values()].filter(fn => fn.file === f.basename);
  const fileDiagram = await buildFileDiagram(f);
  const diagramSection = diagramBlockSvg(fileDiagram.svgs,
    { defaultEngine: fileDiagram.defaultEngine, varsToggle: fileDiagram.varsToggle, diagramId: 'file_' + sanitize(f.basename) });
  const body = `
<h1>${escapeHtml(f.basename)}</h1>
<p class="muted">${escapeHtml(f.filePath)}</p>
${LEGEND}
${diagramSection}
<h2>Функции этого файла</h2>
${fnsHere.length ? '<ul>' + fnsHere.map(fn =>
    `<li><a href="../functions/${pageName(fn.key)}.html">${escapeHtml(fn.name)}</a> <span class="sig">${escapeHtml(fn.signature)}</span>${fn.desc ? ` — ${escapeHtml(fn.desc)}` : ''}</li>`).join('\n') + '</ul>'
    : '<p class="muted">нет</p>'}`;
  fs.writeFileSync(path.join(filesDir, `${sanitize(f.basename)}.html`),
    htmlPage({ title: f.basename, rel: '../', path: `files/${sanitize(f.basename)}.html`, body }));
}

// per-function pages
for (const fn of funcs.values()) {
  const varList = [...fn.access.entries()].map(([varKey, mode]) => {
    const v = varDefs.get(varKey);
    const modeText = { r: 'читает', w: 'пишет', rw: 'читает + пишет' }[mode];
    return `<li><b>${escapeHtml(v.name)}</b> — ${modeText}${v.isVolatile ? ' <b style="color:#dc2626">volatile</b>' : ''}${v.file ? ` <span class="muted">(${escapeHtml(v.file)})</span>` : ' <span class="muted">(внешняя)</span>'}${v.desc ? ` — ${escapeHtml(v.desc)}` : ''}</li>`;
  }).join('\n');
  const cfg = await buildCfgDiagram(fn);
  const funcDiagram = await buildFunctionDiagram(fn);
  const body = `
<h1>${escapeHtml(fn.name)}${fn.isISR ? ' <span style="color:#dc2626;font-size:0.8em">обработчик прерывания</span>' : ''}</h1>
<p><span class="sig">${escapeHtml(fn.signature)}</span> &nbsp; в файле <a href="../files/${sanitize(fn.file)}.html">${escapeHtml(fn.file)}</a></p>
${fn.desc ? `<p>${escapeHtml(fn.desc)}</p>` : ''}
${LEGEND}
${cfg ? `<h2>Алгоритм</h2>
<p class="muted">Порядок выполнения: ромбы — условия и циклы, синие блоки — вызовы (двойной клик — перейти), «да/нет» — ветви.</p>
${diagramBlockSvg(cfg.svgs, { defaultEngine: cfg.defaultEngine, varsToggle: false, diagramId: 'cfg_' + pageName(fn.key) })}` : ''}
<h2>Связи</h2>
${diagramBlockSvg(funcDiagram.svgs, { defaultEngine: funcDiagram.defaultEngine, varsToggle: funcDiagram.varsToggle, diagramId: 'fndiag_' + pageName(fn.key), focus: fnId(fn.key) })}
${varList ? `<h2>Глобальные переменные функции</h2><ul>${varList}</ul>` : ''}`;
  fs.writeFileSync(path.join(funcsDir, `${pageName(fn.key)}.html`),
    htmlPage({ title: fn.name, rel: '../', path: `functions/${pageName(fn.key)}.html`, body, cfgLinks: cfg ? cfg.links : undefined }));
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

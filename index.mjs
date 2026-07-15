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

// every named identifier leaf under a (possibly grouped/OR'd) expression,
// e.g. collectIdentifiers for `(FLAG1 | FLAG2)` -> {FLAG1, FLAG2} — used to
// pull every flag name out of a bitmask test regardless of how many bits it
// checks at once.
function collectIdentifiers(node, out) {
  if (node.type === 'identifier') { out.add(node.text); return; }
  if (node.type === 'parenthesized_expression' || node.type === 'binary_expression') {
    for (const c of node.namedChildren) collectIdentifiers(c, out);
  }
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
  // named bits tested against a register in a bitwise-AND, e.g. the
  // "USART_SR_RXNE" in `if (X->SR & USART_SR_RXNE)` — this is how ISR bodies
  // near-universally spell "which specific interrupt source is this",
  // usually invisible once periph access is collapsed to just the register.
  // name -> Map(field -> Set(flag name))
  const derefFlags = new Map();
  const access = new Map(); // name -> { r, w }
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
      // skip the *declared name* itself, but not initializer values / array sizes
      if (p && (p.type.endsWith('_declarator')) && sameNode(p.childForFieldName('declarator'), n)) return;
      const name = n.text;
      if (locals.has(name)) return;
      const mode = classifyAccess(n);
      if (p && p.type === 'field_expression' && p.childForFieldName('operator')?.text === '->'
          && sameNode(p.childForFieldName('argument'), n)) {
        derefNames.add(name);
        const field = p.childForFieldName('field')?.text;
        if (field) {
          let fm = derefFields.get(name);
          if (!fm) { fm = new Map(); derefFields.set(name, fm); }
          fm.set(field, mergeMode(fm.get(field), mode));

          // "X->field & FLAG" (either operand order) — collect every named
          // identifier on the other side, so `& (FLAG1 | FLAG2)` yields both
          const bexpr = p.parent;
          if (bexpr && bexpr.type === 'binary_expression' && bexpr.childForFieldName('operator')?.text === '&') {
            const left = bexpr.childForFieldName('left'), right = bexpr.childForFieldName('right');
            const other = sameNode(left, p) ? right : (sameNode(right, p) ? left : null);
            if (other) {
              const flagNames = new Set();
              collectIdentifiers(other, flagNames);
              if (flagNames.size) {
                let flagMap = derefFlags.get(name);
                if (!flagMap) { flagMap = new Map(); derefFlags.set(name, flagMap); }
                if (!flagMap.has(field)) flagMap.set(field, new Set());
                for (const fl of flagNames) flagMap.get(field).add(fl);
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

  return { calls, armCalls, derefNames, derefFields, derefFlags, access, signature, loopCallNames, hasLoop };
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
      periphFlags: new Map(),  // peripheral name -> Map(register -> Set(flag name))
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
        // a peripheral register block from a vendor header we didn't parse
        const p = periph(name);
        const m = (mode.r ? 'r' : '') + (mode.w ? 'w' : '');
        const prev = rec.periphAccess.get(name);
        rec.periphAccess.set(name, prev && prev !== m ? 'rw' : (m || 'r'));
        if (mode.r) p.readers.add(rec.key);
        if (mode.w) p.writers.add(rec.key);
        // carry the per-register breakdown onto both the function (for its own
        // "Связи" diagram) and the peripheral (union, for level 0's node label)
        const flds = fn.derefFields.get(name);
        if (flds) {
          let rf = rec.periphFields.get(name);
          if (!rf) { rf = new Map(); rec.periphFields.set(name, rf); }
          for (const [field, fm] of flds) {
            rf.set(field, mergeMode(rf.get(field), fm));
            p.fields.set(field, mergeMode(p.fields.get(field), fm));
          }
        }
        const flagsByField = fn.derefFlags.get(name);
        if (flagsByField) {
          let rflag = rec.periphFlags.get(name);
          if (!rflag) { rflag = new Map(); rec.periphFlags.set(name, rflag); }
          for (const [field, flags] of flagsByField) {
            if (!rflag.has(field)) rflag.set(field, new Set());
            for (const fl of flags) rflag.get(field).add(fl);
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

// every flag name an ISR tests via `X->REG & FLAG` anywhere in its body
// (see periphFlags/derefFlags) — deduped and capped, since a handler that
// juggles several sources (e.g. a shared DMA IRQ) can rack up a dozen.
function isrFlagList(fn, cap = 6) {
  const all = new Set();
  for (const regs of fn.periphFlags.values()) for (const flags of regs.values()) for (const f of flags) all.add(f);
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
    if (flags) rows.push(`<FONT POINT-SIZE="9">флаги: ${dotEsc(flags)}</FONT>`);
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
const MODE_WORD = { r: 'чтение', w: 'запись', rw: 'чтение/запись' };
// "CCR: запись\nCNDTR: запись" from a Map(register -> mode), for the edge
// label rather than the node — packing the register list into the
// peripheral's own node label used to stretch it across the whole diagram
// once a peripheral was touched from several entries/functions; a per-edge
// label keeps the node compact and ties each register straight to *who*
// touches it. Registers alphabetised so the same access reads the same way
// wherever it appears; \n is graphviz's own line-break escape for a plain
// (non-HTML) label, not a literal newline. Capped, so an edge from a
// call-tree that touches a dozen registers doesn't grow a giant label.
function periphRegEdgeLabel(fields, cap = 6) {
  if (!fields || !fields.size) return '';
  const regs = [...fields.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const shown = regs.slice(0, cap).map(([f, m]) => `${f}: ${MODE_WORD[m]}`);
  if (regs.length > cap) shown.push(`+${regs.length - cap}`);
  return shown.join('\\n');
}
function dotPeriphNode(p) {
  const hot = p.isrTargets.size > 0 && (p.readers.size + p.writers.size) > 0;
  return dotNode(periphId(p.name), [dotKindRow('периферия'), `<B>${dotEsc(p.name)}</B>`], 'hexagon', hot ? 'periphhot' : 'periph');
}
// peripheral as it appears on a single function's "Связи" diagram — same
// compact block as dotPeriphNode, register detail lives on the edge instead
// (see periphRegEdgeLabel).
function dotPeriphRelNode(name) {
  return dotNode(periphId(name), [dotKindRow('периферия'), `<B>${dotEsc(name)}</B>`], 'hexagon', 'periph');
}
// aggregate a register map down to one direction for the fn<->periph edge
function periphAggMode(fields) {
  let r = false, w = false;
  for (const m of fields.values()) { if (m.includes('r')) r = true; if (m.includes('w')) w = true; }
  return r && w ? 'rw' : w ? 'w' : 'r';
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

function dotEdge(from, to, { dir = 'forward', style, label, penwidth } = {}) {
  const attrs = [`dir=${dir}`];
  if (style) attrs.push(`style=${style}`);
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
function dotPeriphAccessEdge(fnKey, periphName, mode, direct, fields) {
  const a = fnId(fnKey), b = periphId(periphName);
  const style = direct ? undefined : 'dashed';
  const label = periphRegEdgeLabel(fields);
  if (mode === 'w') return dotEdge(a, b, { style, label });
  if (mode === 'rw') return dotEdge(a, b, { dir: 'both', style, label });
  return dotEdge(b, a, { style, label });
}
const dotArmEdge = (fnKey, periphName) =>
  dotEdge(fnId(fnKey), periphId(periphName), { style: 'dashed', label: 'взводит' });
const dotTriggerEdge = (periphName, fnKey) =>
  dotEdge(periphId(periphName), fnId(fnKey), { penwidth: 2.2, label: 'прерывание' });
// plain call graph edge — dashed, control transfer rather than data
const dotCallEdge = (fromKey, toKey) => dotEdge(fnId(fromKey), fnId(toKey), { style: 'dashed' });
const dotExtCallEdge = (fromKey, name) => dotEdge(fnId(fromKey), extId(name), { style: 'dashed' });
function dotAccessEdges(fnKey, varKey, mode) {
  const a = fnId(fnKey), b = varId(varKey);
  if (mode === 'w') return [dotEdge(a, b)];
  if (mode === 'rw') return [dotEdge(a, b, { dir: 'both' })];
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
  const build = (nodeLines, edgeLines, engine) => {
    const engineAttrs = engine === 'dot'
      ? `rankdir=${rankdir}, ranksep=0.6`
      : 'overlap=false, splines=true, sep="+12"';
    return ['digraph G {',
      `  graph [fontname="Segoe UI, Helvetica, sans-serif", nodesep=0.35, ${engineAttrs}];`,
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
// hardware trigger back into ISRs, and the globals they exchange data through
// — directly (solid) or somewhere inside their call trees (dashed). Variables
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
function aggregateEntryInfo(entries, seedFn) {
  const varInfo = new Map(), periphInfo = new Map(), periphFieldInfo = new Map(), armInfo = new Map();
  for (const e of entries) {
    const vAcc = new Map(), pAcc = new Map(), aAcc = new Set(), pFields = new Map();
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
      for (const pk of f.arms) aAcc.add(pk);
    }
    absorb(e.key, true);
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
    armInfo.set(e.key, aAcc);
  }
  return { varInfo, periphInfo, periphFieldInfo, armInfo };
}

// Builds one Level 0 variant's node/edge lines from an aggregateEntryInfo()
// result — idPrefix keeps this variant's var-bundle ids (bnd_0, bnd_1, ...)
// from colliding with the *other* variant's when both sets of extraNodes get
// merged into one page (same bundle-count coincidence would otherwise mean
// two totally different variable lists sharing one id and one tooltip).
function assembleLevel0(entries, info, idPrefix) {
  const { varInfo, periphInfo, periphFieldInfo, armInfo } = info;

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

  const LEVEL0_MAX_UNITS = 50;
  let varCapNote = '';
  if (bundles.length > LEVEL0_MAX_UNITS) {
    const total = bundles.length;
    const bundleScore = b => b.vars.reduce((s, vk) => s + (varDefs.get(vk)?.score || 0), 0);
    bundles.sort((a, b) => bundleScore(b) - bundleScore(a));
    bundles = bundles.slice(0, LEVEL0_MAX_UNITS);
    varCapNote = `показаны ${LEVEL0_MAX_UNITS} самых используемых каналов данных из ${total}`;
  }

  const usedPeriphs = new Set();
  for (const e of entries) {
    for (const pk of periphInfo.get(e.key).keys()) usedPeriphs.add(pk);
    for (const pk of armInfo.get(e.key)) usedPeriphs.add(pk);
  }
  for (const p of peripherals.values()) if (p.isrTargets.size) usedPeriphs.add(p.name);

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
  for (const e of entries) nodeLines.push(dotFnNode(e));
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
    }
  }

  for (const e of entries) {
    const pAcc = periphInfo.get(e.key);
    const pFields = periphFieldInfo.get(e.key);
    for (const p of periphList) {
      const a = pAcc.get(p.name);
      if (!a) continue;
      const mode = a.r && a.w ? 'rw' : a.w ? 'w' : 'r';
      edgeLines.push(dotPeriphAccessEdge(e.key, p.name, mode, a.direct, pFields.get(p.name)));
    }
    const aAcc = armInfo.get(e.key);
    for (const p of periphList) {
      if (aAcc.has(p.name)) edgeLines.push(dotArmEdge(e.key, p.name));
    }
  }
  for (const p of periphList) {
    for (const isrKey of p.isrTargets) {
      if (funcs.has(isrKey)) edgeLines.push(dotTriggerEdge(p.name, isrKey));
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
    }
    extraNodes[id] = {
      label: `${vars.length} перем.`, kind: 'gvar',
      desc: vars.map(v => v.name).sort().join(', '),
    };
  }

  const note = [varCapNote, periphCapNote].filter(Boolean).join('; ');
  return { nodeLines, edgeLines, varNodeLines, varEdgeLines, extraNodes, note };
}

async function buildLevel0Diagram() {
  const entries = [...funcs.values()].filter(f => f.isEntry || f.isISR);
  if (entries.length === 0) return null;

  const allInfo = aggregateEntryInfo(entries, e => [...e.calls]);
  const all = assembleLevel0(entries, allInfo, 'a');
  const { svgs, hasVars, testRawDot } = await renderDotAll(all.nodeLines, all.edgeLines, all.varNodeLines, all.varEdgeLines);

  // "cyclic-only": entries whose own top-level infinite loop was found (see
  // findTopLevelInfiniteLoop) are seeded from *just* that loop's own calls
  // instead of their whole call tree, so one-time setup (main's clock/GPIO/
  // peripheral init, all made *before* the loop) is never visited at all —
  // an entry with no detected loop falls back to its whole tree rather than
  // silently vanishing. ISRs always use their whole tree: an ISR firing at
  // all *is* the cyclic/runtime behavior, it has no "setup phase" of its own.
  const cyclicInfo = aggregateEntryInfo(entries, e => (e.isISR ? [...e.calls] : (e.hasLoop ? [...e.loopCalls] : [...e.calls])));
  const cyclic = assembleLevel0(entries, cyclicInfo, 'c');
  const cyclicRender = await renderDotAll(cyclic.nodeLines, cyclic.edgeLines, cyclic.varNodeLines, cyclic.varEdgeLines);
  for (const [k, v] of Object.entries(cyclicRender.svgs)) svgs[`${k}_cyclic`.replace('_novars_cyclic', '_cyclic_novars')] = v;
  // "_novars_cyclic" -> "_cyclic_novars": renderDotAll's own keys are
  // "<engine>"/"<engine>_novars"; appending "_cyclic" after the fact needs to
  // land the segment in the same order wireDiagramToolbar/setupEngineSwitchable
  // build it in client-side (<engine>_cyclic_novars, not <engine>_novars_cyclic)

  // TEMPORARY: same shape either way ({withVars, noVars}), just also split by
  // the cyclic toggle now — see wireNeatoModeTester in viewer.js, which reads
  // both checkboxes to pick the right one of these four.
  const combinedTestRawDot = testRawDot ? { all: testRawDot, cyclic: cyclicRender.testRawDot } : undefined;

  return {
    svgs,
    varsToggle: hasVars,
    cyclicToggle: entries.some(e => e.isISR || e.hasLoop),
    note: [all.note, cyclic.note].filter(Boolean).join('; '),
    extraNodes: { ...all.extraNodes, ...cyclic.extraNodes },
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
  // the "переменные" toggle) rather than the call nodes
  for (const [pName, fields] of fn.periphFields) {
    varNodeLines.push(dotPeriphRelNode(pName));
    varEdgeLines.push(dotPeriphAccessEdge(fn.key, pName, periphAggMode(fields), true, fields));
  }
  const { svgs, hasVars } = await renderDotAll(nodeLines, edgeLines, varNodeLines, varEdgeLines);
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
  <span>точка входа <b>&rarr;</b> периферия = <b>запись</b>, обратная стрелка = <b>чтение</b>, <b>&harr;</b> = обе</span>
  <span>сплошная линия — точка входа обращается сама (в своём теле), пунктирная — где-то внутри функций, которые она вызывает</span>
  <span><span class="chip" style="background:#e0e7ff;border-color:#4338ca"></span>&#11039; периферия (регистры вида <code>X-&gt;поле</code>)</span>
  <span><b>&#8943;&gt;</b> «взводит» — вызов NVIC_EnableIRQ на эту периферию</span>
  <span><b>=&gt;</b> «прерывание» — периферия вызывает обработчик по её имени</span>
  <span>цилиндр с несколькими именами — переменные, связанные с одним и тем же набором точек входа, собранные в один жгут</span>
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
function diagramBlockSvg(svgs, { defaultEngine = 'neato', varsToggle = true, cyclicToggle = false, diagramId = 'gv', focus, testRawDot } = {}) {
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
${varsToggle ? '  <label class="gv-ctrl"><input type="checkbox" class="gv-vars-toggle" checked> переменные</label>\n' : ''}${cyclicToggle ? '  <label class="gv-ctrl"><input type="checkbox" class="gv-cyclic-toggle"> только цикличное</label>\n' : ''}  <select class="gv-engine-select">
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
      // peripherals touched directly, with per-register detail — lets the
      // client rebuild the "Связи" diagram show e.g. "UART2: CR1 (запись)"
      // exactly as the build-time SVG does (see dotPeriphRelNode)
      periph: fn.periphFields.size
        ? [...fn.periphFields.entries()].map(([name, fields]) => ({
            id: periphId(name), name,
            regs: [...fields.entries()].map(([reg, mode]) => ({ reg, mode })),
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
    ? diagramBlockSvg(level0.svgs, { diagramId: 'level0', varsToggle: level0.varsToggle, cyclicToggle: level0.cyclicToggle, testRawDot: level0.testRawDot })
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
Сплошная связь — точка входа обращается сама, пунктирная — где-то внутри её вызовов;
пунктир с подписью «взводит» — вызов NVIC_EnableIRQ; жирная стрелка «прерывание» — периферия вызывает обработчик по имени.
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

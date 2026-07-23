// Extension-host analyzer: parse a C source with web-tree-sitter (WASM, no
// native ABI — see the memory note vscode-ext-treesitter-wasm), build the
// control-flow graph of the function around a given line, and render it to SVG
// via graphviz-wasm. This is a focused port of buildCfg + buildCfgDiagram from
// the CLI's index.mjs, extended so every CFG node carries the source line range
// it came from — that's what powers click-to-code and scroll-sync in the
// webview. The CLI keeps its own copy; unifying the two is a later milestone.

import { ensureWasmRuntime, getGraphviz, parseC } from './wasm-runtime.mjs';

// --- one-time WASM init (parser runtime + C grammar + graphviz) -------------
// Delegated to wasm-runtime.mjs, shared with level0-analyzer.mjs — both are
// import()-ed from the same absolute path, so Node's module cache dedupes it.

export async function initAnalyzer({ wasmDir }) {
  await ensureWasmRuntime({ wasmDir });
}

// --- CFG construction (ported from index.mjs buildCfg, + line ranges) -------

const CFG_MAX_NODES = 200;

function walkTree(node, cb) {
  cb(node);
  for (const child of node.children) walkTree(child, cb);
}

const CFG_SHAPE = { term: 'ellipse', ret: 'ellipse', cond: 'diamond', loop: 'diamond', call: 'box', jump: 'ellipse', periph: 'hexagon' };
const CFG_CLASS = { term: 'cfgterm', ret: 'cfgterm', cond: 'cfgcond', loop: 'cfgcond', call: 'cfgcall', jump: 'cfgjump', periph: 'cfgperiph' };

// Ported (simplified) from level0-analyzer.mjs's findNameInDeclarator — walks
// a declarator down to its bound identifier, through pointer/array/init
// wrapping (`U1Msg *m = ...` -> `m`).
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

// Every name this function binds itself — parameters plus locally declared
// variables/loop counters — so a `->` field access rooted at one of them
// (e.g. `m->data` off `U1Msg *m = &u1_q[...]`) reads as "just a local
// struct", not a peripheral register. Anything else `X->field` is rooted at
// (DMA1_Channel4, GPIOA, ...) is, by elimination, a real global/peripheral —
// same test level0-analyzer.mjs's analyzeFunction uses (`!locals.has(name)`),
// ported here so the per-function CFG view doesn't need the whole-project
// scan level0 depends on for the same fact.
function collectLocals(paramsNode, bodyNode) {
  const locals = new Set();
  if (paramsNode) {
    walkTree(paramsNode, (n) => {
      if (n.type === 'parameter_declaration') {
        const nm = findNameInDeclarator(n.childForFieldName('declarator'));
        if (nm) locals.add(nm);
      }
    });
  }
  if (bodyNode) {
    walkTree(bodyNode, (n) => {
      if (n.type === 'declaration') {
        for (const child of n.namedChildren) {
          if (!child.type.endsWith('declarator')) continue;
          const nm = findNameInDeclarator(child);
          if (nm) locals.add(nm);
        }
      }
    });
  }
  return locals;
}

// Does statement `s` touch a peripheral register (`X->field` where X isn't
// one of this function's own locals)? Answers the user's complaint
// (2026-07-22) that a straight-line run of DMA1_Channel4->CCR/CMAR/CNDTR
// writes got folded into one invisible "trivial algorithm" placeholder —
// this is what promotes such statements into their own visible CFG node
// (kind 'periph', drawn as a purple hexagon — same visual language as the
// periph/DMA blocks in «Уровень 0»/«Связи», see media/main.css .cfgperiph).
function hasPeriphAccess(s, locals) {
  let found = false;
  walkTree(s, (n) => {
    if (found || n.type !== 'field_expression') return;
    if (n.childForFieldName('operator')?.text !== '->') return;
    // peel `[index]` layers off the base too — an array of channel/peripheral
    // pointers (`chans[i]->CCR`) names a peripheral just as directly as a
    // bare `DMA1_Channel4->CCR` does (same unwrap level0-analyzer.mjs's
    // resolveAddrExpr applies when resolving a DMA target's own base).
    let base = n.childForFieldName('argument');
    while (base && base.type === 'subscript_expression') base = base.childForFieldName('argument');
    while (base && base.type === 'parenthesized_expression') base = base.namedChildren[0];
    if (base && base.type === 'identifier' && !locals.has(base.text)) found = true;
  });
  return found;
}

// A loop body that does nothing — a bare `;` or empty `{}` — the spin-wait
// idiom (`while (!ready) ;`). Drawing a dedicated node for it is pure noise.
function isEmptyBody(node) {
  if (!node) return true;
  if (node.type === 'compound_statement' || node.type === 'expression_statement') return node.namedChildren.length === 0;
  return false;
}

// A condition that's a compile-time-nonzero constant (`while (1)`,
// `while (true)`) — the loop can only ever be left via an explicit break (or
// a return/goto, handled elsewhere), so drawing the generic "нет" exit
// fabricates a fall-through path the code can't actually take.
function isAlwaysTruthy(condNode) {
  if (!condNode) return false;
  let inner = condNode;
  while (inner.type === 'parenthesized_expression' && inner.namedChildren.length === 1) inner = inner.namedChildren[0];
  if (inner.type === 'number_literal') {
    const v = parseInt(inner.text, undefined);
    return !Number.isNaN(v) && v !== 0;
  }
  return inner.type === 'identifier' && /^(true|TRUE)$/.test(inner.text);
}

function buildCfg(body, { startLabel, endLabel, locals } = {}) {
  if (!body) return null;
  const localNames = locals || new Set();
  const nodes = [];
  const edges = [];
  let seq = 0;

  // Which loop (if any) a node was created inside of — drives cfgToSvg's
  // cluster boxes (user report 2026-07-22: the loop-exit edge reads as
  // "wanders off across the diagram" rather than "leaves the loop", so wrap
  // each loop's own nodes in a visible box instead). loopScopeStack's top is
  // the *innermost* loop currently being built; loopParent records each
  // loop's own enclosing loop (or null for a top-level loop), letting
  // cfgToSvg nest cluster subgraphs the same way the loops themselves nest.
  let loopSeq = 0;
  const loopScopeStack = [];
  const loopParent = new Map(); // loopId -> parent loopId | null

  // node param is the tree-sitter node this CFG node came from (may be null for
  // the synthetic начало/конец terminals) — its row span drives line-mapping.
  // `vars` defaults to every identifier under `node` (see identNames) — good
  // enough for "does this block reference X" highlighting; callers that need
  // a narrower scope (a for-loop's header without its body, say) pass an
  // explicit Set instead.
  const mkNode = (kind, label, calls = [], node = null, vars = null) => {
    const id = 'c' + seq++;
    const startLine = node ? node.startPosition.row : null;
    const endLine = node ? node.endPosition.row : null;
    const varsOut = vars || (node ? identNames(node) : new Set());
    const loopScope = loopScopeStack.length ? loopScopeStack[loopScopeStack.length - 1] : null;
    nodes.push({ id, kind, label, calls, vars: varsOut, startLine, endLine, loopScope });
    return id;
  };
  const mkEdge = (from, to, label) => { edges.push({ from, to, label: label || '' }); };
  const attach = (pending, id) => { for (const p of pending) mkEdge(p.from, id, p.label); };
  const openLoopScope = () => {
    const id = 'L' + loopSeq++;
    loopParent.set(id, loopScopeStack.length ? loopScopeStack[loopScopeStack.length - 1] : null);
    loopScopeStack.push(id);
    return id;
  };
  const closeLoopScope = () => { loopScopeStack.pop(); };
  // The loop's own "condition now false" exit — attributed to wherever the
  // body naturally finished an iteration (the same nodes that already feed
  // the "loop again" back-edge, built right alongside this in every loop
  // case below), not to the loop header (`cond`) itself: a single edge
  // straight off the header read as "jumps out of nowhere, crossing the
  // whole diagram" (user report 2026-07-22) — this also matches how a
  // rotated/bottom-tested loop actually compiles, where the recheck sits
  // right after the body rather than at a separately revisited header.
  // Falls back to `cond` itself only when there's no body node to attribute
  // it to (while's empty-body spin-wait case).
  const loopExit = (cond, bodyExits, label) =>
    (bodyExits && bodyExits.length ? bodyExits : [{ from: cond }]).map((e) => ({ from: e.from, label }));

  const trunc = (s, n = 40) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const callNames = (n) => {
    const out = [];
    walkTree(n, (x) => {
      if (x.type === 'call_expression') {
        const f = x.childForFieldName('function');
        if (f && f.type === 'identifier') out.push(f.text);
      }
    });
    return out;
  };
  // Every identifier referenced under `n` — variable reads/writes, and
  // (redundantly with callNames) call targets. Feeds the "select a variable
  // in code -> highlight every CFG block that touches it" webview feature;
  // the redundancy with call targets is harmless there since the webview
  // checks calls first.
  const identNames = (n) => {
    const out = new Set();
    walkTree(n, (x) => {
      if (x.type === 'identifier') out.add(x.text);
    });
    return out;
  };

  const labelIds = new Map();
  const gotos = [];
  const SIMPLE = new Set(['expression_statement', 'declaration']);

  function buildSeq(stmts, ctx) {
    let entry = null;
    let pending = [];
    let alive = true;
    let blockLines = [];
    let blockNodes = []; // source nodes folded into the current straight-line block

    const flushBlock = () => {
      if (!blockLines.length) return;
      const shown = blockLines.slice(0, 4);
      if (blockLines.length > 4) shown.push('…');
      // span the whole run of folded statements, so scrolling anywhere inside
      // the block highlights this one node.
      const first = blockNodes[0], last = blockNodes[blockNodes.length - 1];
      const spanNode = {
        startPosition: { row: first.startPosition.row },
        endPosition: { row: last.endPosition.row },
      };
      // spanNode is synthetic (no .children) — identNames can't walk it, so
      // union the real per-statement identifiers gathered before folding.
      const vars = new Set();
      for (const bn of blockNodes) for (const nm of identNames(bn)) vars.add(nm);
      const id = mkNode('stmt', shown.join('\n'), [], spanNode, vars);
      if (!entry) entry = id;
      attach(pending, id);
      pending = [{ from: id }];
      blockLines = [];
      blockNodes = [];
    };

    for (const s of stmts) {
      if (!alive) break;
      if (s.type === 'comment') continue;
      if (SIMPLE.has(s.type)) {
        const calls = callNames(s);
        if (calls.length) {
          flushBlock();
          const id = mkNode('call', trunc(s.text, 46), calls, s);
          if (!entry) entry = id;
          attach(pending, id);
          pending = [{ from: id }];
        } else if (hasPeriphAccess(s, localNames)) {
          flushBlock();
          const id = mkNode('periph', trunc(s.text, 46), [], s);
          if (!entry) entry = id;
          attach(pending, id);
          pending = [{ from: id }];
        } else {
          blockLines.push(trunc(s.text));
          blockNodes.push(s);
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
      const kind = calls.length ? 'call' : hasPeriphAccess(s, localNames) ? 'periph' : 'stmt';
      const id = mkNode(kind, trunc(s.text, 46), calls, s);
      return { entry: id, exits: [{ from: id }] };
    }
    return buildStmt(s, ctx);
  }

  function buildStmt(s, ctx) {
    switch (s.type) {
      case 'compound_statement':
        return buildSeq(s.namedChildren, ctx);

      case 'if_statement': {
        const condNode = s.childForFieldName('condition') || s;
        const cond = mkNode('cond', trunc('if ' + (s.childForFieldName('condition')?.text ?? '')), callNames(condNode), condNode);
        const exits = [];
        const cr = buildAny(s.childForFieldName('consequence'), ctx);
        if (cr && cr.entry) { mkEdge(cond, cr.entry, 'да'); exits.push(...cr.exits); }
        else exits.push({ from: cond, label: 'да' });
        const altClause = s.childForFieldName('alternative');
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
        openLoopScope();
        const condNode = s.childForFieldName('condition') || s;
        const cond = mkNode('loop', trunc('while ' + (s.childForFieldName('condition')?.text ?? '')), callNames(condNode), condNode);
        const bodyNode = s.childForFieldName('body');
        const breaks = [];
        let br = null;
        // spin-wait idiom (`while (!ready) ;`) — see isEmptyBody. No
        // self-loop arrow and no "нет" label on the exit either (user
        // report 2026-07-22): the diamond IS the whole loop, so a "да" arrow
        // curling back into the very same shape is a visual no-op, and a
        // self-loop condition only has the one way out — spelling it "нет"
        // just states the obvious.
        const isSpin = isEmptyBody(bodyNode);
        if (!isSpin) {
          br = buildAny(bodyNode, { ...ctx, breaks, continueTo: cond });
          if (br && br.entry) {
            mkEdge(cond, br.entry, 'да');
            for (const e of br.exits) mkEdge(e.from, cond, e.label);
          }
        }
        closeLoopScope();
        // see isAlwaysTruthy — `while (1)` etc. only exits via an explicit
        // break, never the generic "нет" fall-through.
        const exits = [...breaks];
        if (!isAlwaysTruthy(condNode)) exits.push(...loopExit(cond, br && br.exits, isSpin ? '' : 'нет'));
        return { entry: cond, exits };
      }

      case 'do_statement': {
        openLoopScope();
        const breaks = [];
        const condNode = s.childForFieldName('condition') || s;
        const cond = mkNode('loop', trunc('while ' + (s.childForFieldName('condition')?.text ?? '')), callNames(condNode), condNode);
        const br = buildAny(s.childForFieldName('body'), { ...ctx, breaks, continueTo: cond });
        let entry = cond;
        if (br && br.entry) {
          entry = br.entry;
          for (const e of br.exits) mkEdge(e.from, cond, e.label);
          mkEdge(cond, br.entry, 'да');
        }
        closeLoopScope();
        const exits = [...breaks, ...loopExit(cond, br && br.exits, 'нет')];
        return { entry, exits };
      }

      case 'for_statement': {
        const bodyNode = s.childForFieldName('body');
        const header = bodyNode ? s.text.slice(0, bodyNode.startIndex - s.startIndex) : s.text;
        // scope vars/calls to the init/condition/update clauses, not bodyNode
        // (which mkNode's own node-based fallback would include via s) — a
        // loop header shouldn't light up for every name used inside the loop.
        const headerVars = new Set();
        const headerCalls = [];
        for (const field of ['initializer', 'condition', 'update']) {
          const c = s.childForFieldName(field);
          if (!c) continue;
          for (const nm of identNames(c)) headerVars.add(nm);
          headerCalls.push(...callNames(c));
        }
        openLoopScope();
        const cond = mkNode('loop', trunc(header, 46), headerCalls, s, headerVars);
        const breaks = [];
        const br = buildAny(bodyNode, { ...ctx, breaks, continueTo: cond });
        if (br && br.entry) {
          mkEdge(cond, br.entry);
          for (const e of br.exits) mkEdge(e.from, cond, e.label);
        }
        closeLoopScope();
        const exits = [...breaks, ...loopExit(cond, br && br.exits, 'конец')];
        return { entry: cond, exits };
      }

      case 'switch_statement': {
        const swCondNode = s.childForFieldName('condition') || s;
        const sw = mkNode('cond', trunc('switch ' + (s.childForFieldName('condition')?.text ?? '')), callNames(swCondNode), swCondNode);
        const breaks = [];
        const bodyNode = s.childForFieldName('body');
        let fall = [];
        let sawDefault = false;
        const cases = bodyNode ? bodyNode.namedChildren.filter((c) => c.type === 'case_statement') : [];
        for (const cs of cases) {
          const valNode = cs.childForFieldName('value');
          const lbl = valNode ? trunc(valNode.text, 20) : 'default';
          if (!valNode) sawDefault = true;
          const stmts = cs.namedChildren.filter((c) => !valNode || c.id !== valNode.id);
          const r = buildSeq(stmts, { ...ctx, breaks });
          if (r.entry) {
            mkEdge(sw, r.entry, lbl);
            attach(fall, r.entry);
            fall = r.exits;
          } else {
            fall.push({ from: sw, label: lbl });
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
        const id = mkNode('ret', trunc(s.text, 42), [], s);
        mkEdge(id, ctx.exitId);
        return { entry: id, exits: [] };
      }

      case 'break_statement': {
        const id = mkNode('jump', 'break', [], s);
        if (ctx.breaks) ctx.breaks.push({ from: id });
        return { entry: id, exits: [] };
      }

      case 'continue_statement': {
        const id = mkNode('jump', 'continue', [], s);
        if (ctx.continueTo) mkEdge(id, ctx.continueTo);
        return { entry: id, exits: [] };
      }

      case 'labeled_statement': {
        const name = s.childForFieldName('label')?.text ?? '';
        const id = mkNode('stmt', name + ':', [], s);
        labelIds.set(name, id);
        const inner = s.namedChildren.find((c) => c.type !== 'statement_identifier');
        const r = inner ? buildAny(inner, ctx) : null;
        if (r && r.entry) { mkEdge(id, r.entry); return { entry: id, exits: r.exits }; }
        return { entry: id, exits: [{ from: id }] };
      }

      case 'goto_statement': {
        const name = s.childForFieldName('label')?.text ?? '';
        const id = mkNode('jump', 'goto ' + name, [], s);
        gotos.push({ from: id, name });
        return { entry: id, exits: [] };
      }

      default: {
        const calls = callNames(s);
        const kind = calls.length ? 'call' : hasPeriphAccess(s, localNames) ? 'periph' : 'stmt';
        const id = mkNode(kind, trunc(s.text, 46), calls, s);
        return { entry: id, exits: [{ from: id }] };
      }
    }
  }

  const startId = mkNode('term', startLabel || 'начало');
  const exitId = mkNode('term', 'конец');
  const r = buildSeq(body.namedChildren, { exitId, breaks: null, continueTo: null });
  if (r.entry) mkEdge(startId, r.entry); else mkEdge(startId, exitId);
  for (const e of r.exits) mkEdge(e.from, exitId, e.label);
  for (const g of gotos) if (labelIds.has(g.name)) mkEdge(g.from, labelIds.get(g.name), 'goto');

  // конец only earns its place when it's telling you something a `return`
  // node doesn't already: if every path into it already passed through an
  // explicit `return expr;` node (kind 'ret'), "return" already means "the
  // function ends here" on its own — a trailing конец bubble right after is
  // pure noise, so it (and the now-pointless edges into it) gets dropped
  // entirely, leaving the return node(s) as natural leaves (user report
  // 2026-07-20: first asked to relabel it to the return type instead of
  // "конец", then decided even that's unnecessary — "и так понятно что
  // ретерн это конец"). Likewise if nothing reaches конец at all — every
  // path diverges into an unescapable `while (1)`-style loop, say — there's
  // nothing to show there either: relabeling it to "return <type>" would
  // fabricate a return the code can never actually perform (user report
  // 2026-07-20: "return int" hanging off a while(1) with no break/return
  // anywhere). Otherwise (a bare `return;`, or falling off the end of a
  // reachable path without any return) конец is the only place that shows
  // up at all, so it stays — relabeled to the return type when there is
  // one, since that IS new information there.
  const incoming = edges.filter((e) => e.to === exitId);
  const allFromReturn = incoming.length > 0 &&
    incoming.every((e) => nodes.find((nn) => nn.id === e.from)?.kind === 'ret');
  let strippedExit = false;
  if (incoming.length === 0 || allFromReturn) {
    const exitIdx = nodes.findIndex((nn) => nn.id === exitId);
    if (exitIdx !== -1) nodes.splice(exitIdx, 1);
    for (let i = edges.length - 1; i >= 0; i--) if (edges[i].to === exitId) edges.splice(i, 1);
    strippedExit = true;
  } else if (endLabel) {
    const exitNode = nodes.find((nn) => nn.id === exitId);
    if (exitNode) exitNode.label = endLabel;
  }

  // caller classifies by nodes.length (trivial <= 3, oversized > CFG_MAX_NODES)
  // and decides whether to render — so the stacked view can still show a
  // placeholder block for those, keeping the column aligned with the file.
  // strippedExit tells the caller to count the dropped конец back in for
  // that check: whether a diagram is "worth drawing" is about the function's
  // control-flow complexity, not about how many decorative terminal nodes
  // happened to survive — a straight-line function ending in `return x;`
  // shouldn't flip from "draw it" to "trivial" purely because конец, above,
  // decided it was redundant and removed itself.
  return { nodes, edges, strippedExit, loopParent };
}

// --- dot emission + graphviz render (ported from index.mjs) -----------------

const dotEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dotNode(id, rows, shape, cls) {
  return `  ${id} [id="${id}" class="${cls}" shape=${shape} label=<${rows.join('<BR/>')}>];`;
}
function dotEdge(id, from, to, label) {
  const l = label ? `, label=<${dotEsc(label)}>` : '';
  return `  ${from} -> ${to} [id="${id}" dir=forward${l}];`;
}

// Nests each loop's own nodes inside a `subgraph cluster_*` block, mirroring
// how the loops themselves nest (cfg.loopParent) — graphviz draws a box
// around each one (styled via main.css's g.cluster rule, same pattern as
// every other node class here) and routes cross-boundary edges (loop exits)
// along it, so a loop's exit edge reads as "this leaves the loop" instead of
// a stray line cutting across unrelated nodes (user report 2026-07-22).
// Graphviz cluster names *must* start with "cluster" to be treated as one.
function emitScopedNodes(cfg) {
  const nodeDot = (n) => {
    const label = n.label.split('\n').map(dotEsc).join('<BR/>');
    return dotNode(n.id, [label], CFG_SHAPE[n.kind] || 'box', CFG_CLASS[n.kind] || 'cfgstmt');
  };
  const nodesByScope = new Map(); // loopId ('' = top level) -> nodes
  for (const n of cfg.nodes) {
    const key = n.loopScope || '';
    if (!nodesByScope.has(key)) nodesByScope.set(key, []);
    nodesByScope.get(key).push(n);
  }
  const childScopes = new Map(); // parent loopId ('' = top level) -> [loopId]
  for (const [id, parent] of cfg.loopParent) {
    const key = parent || '';
    if (!childScopes.has(key)) childScopes.set(key, []);
    childScopes.get(key).push(id);
  }
  function emitScope(scopeKey, depth) {
    const lines = [];
    const pad = '  '.repeat(depth);
    const inCluster = scopeKey !== '';
    if (inCluster) {
      lines.push(`${pad}subgraph cluster_${scopeKey} {`);
      lines.push(`${pad}  style=rounded; color=gray; bgcolor=white; margin=18;`);
    }
    for (const child of (childScopes.get(scopeKey) || [])) lines.push(...emitScope(child, depth + 1));
    const inner = inCluster ? pad + '  ' : pad;
    for (const n of (nodesByScope.get(scopeKey) || [])) lines.push(inner + nodeDot(n));
    if (inCluster) lines.push(`${pad}}`);
    return lines;
  }
  return emitScope('', 0);
}

function cfgToSvg(cfg) {
  const nodeLines = emitScopedNodes(cfg);
  // explicit ids (e0, e1, ...) so the webview can select a specific edge
  // element directly instead of relying on graphviz's auto "edgeN" ids, which
  // carry no from/to information.
  cfg.edges.forEach((e, i) => { e.id = 'e' + i; });
  const edgeLines = cfg.edges.map((e) => dotEdge(e.id, e.from, e.to, e.label));
  const dot = [
    'digraph G {',
    // transparent, not white: graphviz otherwise paints an opaque background
    // polygon covering the whole canvas, which reads as a stray white box
    // once the webview sits on a dark VS Code theme. Node/edge colors are
    // still styled by CSS class (see media/main.css), independent of this.
    '  graph [fontname="Segoe UI, Helvetica, sans-serif", nodesep=0.35, rankdir=TB, ranksep=0.6, bgcolor=transparent];',
    '  node [fontname="Segoe UI, Helvetica, sans-serif", style=filled, fillcolor=white];',
    '  edge [fontname="Segoe UI, Helvetica, sans-serif", fontsize=10];',
    ...nodeLines, ...edgeLines, '}',
  ].join('\n');
  const svg = getGraphviz().layout(dot, 'svg', 'dot');
  // strip the XML prolog / DOCTYPE / leading comments — the webview injects
  // this via innerHTML, where a leading <?xml?> parses as a bogus comment.
  const at = svg.indexOf('<svg');
  return at > 0 ? svg.slice(at) : svg;
}

// --- function lookup --------------------------------------------------------

const labelTrunc = (s, n = 46) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Walks a function_definition's declarator down to its function_declarator
// (through any wrapping pointer_declarator — `char *foo(int x)` nests one
// around the function_declarator) — finds the name, the parameter_list, and
// how many pointer_declarator layers were passed through on the way (needed
// to reconstruct a pointer return type: tree-sitter's own `type` field only
// ever holds the base type, e.g. "char" for "char *foo(...)", with the "*"
// living on the declarator chain instead).
function analyzeDeclarator(fnDefNode) {
  let decl = fnDefNode.childForFieldName('declarator');
  const seen = new Set();
  let pointerDepth = 0;
  while (decl && !seen.has(decl.id)) {
    seen.add(decl.id);
    if (decl.type === 'pointer_declarator') pointerDepth++;
    if (decl.type === 'function_declarator') {
      const d = decl.childForFieldName('declarator');
      const params = decl.childForFieldName('parameters');
      if (d && d.type === 'identifier') return { name: d.text, params, pointerDepth };
      decl = d;
      continue;
    }
    decl = decl.childForFieldName('declarator') || decl.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier');
  }
  return { name: null, params: null, pointerDepth };
}

// Entry/exit terminal labels derived from the function's own signature — the
// parameter list for "начало" (what comes in) and "return <type>" for
// "конец" when the function actually returns something (user request
// 2026-07-20), instead of the generic placeholder words. endLabel is only a
// *candidate* here — buildCfg only actually applies it to конец when at
// least one path reaches конец WITHOUT going through an explicit
// `return expr;` node first (see buildCfg's own comment): when every path
// already shows its return value via its own node, restating the type again
// on конец read as a second, unrelated-looking return (user report
// 2026-07-20, dbg_put_hex16: "return 4u;" immediately followed by
// "return uint16_t").
function signatureLabels(fnDefNode, declInfo) {
  let startLabel = null;
  const paramsText = declInfo.params ? declInfo.params.text.replace(/^\(|\)$/g, '').trim() : '';
  if (paramsText && paramsText !== 'void') startLabel = labelTrunc(paramsText);

  let endLabel = null;
  const typeNode = fnDefNode.childForFieldName('type');
  const returnType = (typeNode ? typeNode.text.trim() : '') + '*'.repeat(declInfo.pointerDepth);
  if (returnType && returnType !== 'void') endLabel = labelTrunc('return ' + returnType);

  return { startLabel, endLabel };
}

function collectFunctions(root) {
  const fns = [];
  walkTree(root, (n) => {
    if (n.type === 'function_definition') {
      const declInfo = analyzeDeclarator(n);
      const { startLabel, endLabel } = signatureLabels(n, declInfo);
      fns.push({
        node: n,
        name: declInfo.name || '(anon)',
        startLine: n.startPosition.row,
        endLine: n.endPosition.row,
        body: n.childForFieldName('body'),
        params: declInfo.params,
        startLabel,
        endLabel,
      });
    }
  });
  return fns;
}

// The function with the most line-overlap against [vStart, vEnd] — i.e.
// whichever function actually dominates the viewport, not just whichever one
// contains its exact midpoint. A single line-count midpoint check falls apart
// whenever the visible range straddles a function and an adjacent block
// comment (common right before a big documented function): the midpoint can
// land in the comment gap, nowhere near the function that's actually filling
// the screen, and the old point-based fallback would silently jump to
// whatever function happens to come "next" in the file — even if that
// function isn't visible at all. Overlap area doesn't have that failure mode:
// a function with zero visible lines can never win against one that's mostly
// or fully on screen. vStart===vEnd degrades this to a plain point-in-range
// test, so single-line callers (see test-analyzer.mjs) still work unchanged.
function pickFunction(fns, vStart, vEnd) {
  if (!fns.length) return null;
  let best = null, bestOverlap = -1;
  for (const f of fns) {
    const overlap = Math.min(f.endLine, vEnd) - Math.max(f.startLine, vStart);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = f; }
  }
  if (bestOverlap >= 0) return best;
  // nothing overlaps at all (scrolled into a comment/gap far from any code) —
  // fall back to the function coming up next, else the last one before it.
  const mid = Math.floor((vStart + vEnd) / 2);
  const after = fns.filter((f) => f.startLine >= mid).sort((a, b) => a.startLine - b.startLine)[0];
  if (after) return after;
  return fns.filter((f) => f.endLine <= mid).sort((a, b) => b.endLine - a.endLine)[0] || null;
}

// Render one function's CFG into the shape the webview consumes, or a
// placeholder descriptor when there's nothing worth drawing (trivial body /
// oversized / no body). `kind` tells the webview which: 'cfg' | 'trivial' |
// 'toobig' | 'none'.
function describeFunction(fn) {
  const base = {
    functionName: fn.name,
    funcRange: { startLine: fn.startLine, endLine: fn.endLine },
    svg: null,
    nodeLines: [],
    edges: [],
  };
  if (!fn.body) return { ...base, kind: 'none' };
  const locals = collectLocals(fn.params, fn.body);
  const cfg = buildCfg(fn.body, { startLabel: fn.startLabel, endLabel: fn.endLabel, locals });
  const n = cfg.nodes.length + (cfg.strippedExit ? 1 : 0);
  if (n <= 3) return { ...base, kind: 'trivial' };
  if (n > CFG_MAX_NODES) return { ...base, kind: 'toobig' };
  const svg = cfgToSvg(cfg); // also assigns e.id on the edges
  return {
    ...base,
    kind: 'cfg',
    svg,
    // per-node line span (0-based, matches VS Code's Position API), plus the
    // identifiers/calls it references — powers the webview's "select a
    // variable/function in code -> highlight every block that touches it"
    // feature. Arrays, not Sets: postMessage to a webview goes through
    // structured clone across a process boundary that not every host is
    // guaranteed to preserve Set through untouched.
    nodeLines: cfg.nodes
      .filter((x) => x.startLine != null)
      .map((x) => ({
        id: x.id, kind: x.kind, startLine: x.startLine, endLine: x.endLine,
        vars: [...x.vars], calls: x.calls,
      })),
    edges: cfg.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
  };
}

// --- public entry -----------------------------------------------------------

// Every function in the file, in source order — the stacked-column model:
// the webview lays these out top-to-bottom and scrolls through them in sync
// with the editor. Node/edge ids repeat across functions (each CFG restarts
// at c0/e0), so the webview must scope its DOM lookups to each function's own
// block rather than querying globally.
export function analyzeAllFunctions(src) {
  const tree = parseC(src);
  const fns = collectFunctions(tree.rootNode).sort((a, b) => a.startLine - b.startLine);
  return { functions: fns.map(describeFunction) };
}

// Single-function probe by visible range [vStart, vEnd] (0-based, inclusive);
// vStart === vEnd is a point probe. Retained for the headless test harness.
export function analyzeFunctionAt(src, vStart, vEnd = vStart) {
  const tree = parseC(src);
  const fns = collectFunctions(tree.rootNode);
  const fn = pickFunction(fns, vStart, vEnd);
  if (!fn) return null;
  const d = describeFunction(fn);
  return d.kind === 'cfg' ? d : null;
}

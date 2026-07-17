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

const CFG_SHAPE = { term: 'ellipse', ret: 'ellipse', cond: 'diamond', loop: 'diamond', call: 'box', jump: 'ellipse' };
const CFG_CLASS = { term: 'cfgterm', ret: 'cfgterm', cond: 'cfgcond', loop: 'cfgcond', call: 'cfgcall', jump: 'cfgjump' };

function buildCfg(body) {
  if (!body) return null;
  const nodes = [];
  const edges = [];
  let seq = 0;

  // node param is the tree-sitter node this CFG node came from (may be null for
  // the synthetic начало/конец terminals) — its row span drives line-mapping.
  const mkNode = (kind, label, calls = [], node = null) => {
    const id = 'c' + seq++;
    const startLine = node ? node.startPosition.row : null;
    const endLine = node ? node.endPosition.row : null;
    nodes.push({ id, kind, label, calls, startLine, endLine });
    return id;
  };
  const mkEdge = (from, to, label) => { edges.push({ from, to, label: label || '' }); };
  const attach = (pending, id) => { for (const p of pending) mkEdge(p.from, id, p.label); };

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
      const id = mkNode('stmt', shown.join('\n'), [], spanNode);
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
      const id = mkNode(calls.length ? 'call' : 'stmt', trunc(s.text, 46), calls, s);
      return { entry: id, exits: [{ from: id }] };
    }
    return buildStmt(s, ctx);
  }

  function buildStmt(s, ctx) {
    switch (s.type) {
      case 'compound_statement':
        return buildSeq(s.namedChildren, ctx);

      case 'if_statement': {
        const cond = mkNode('cond', trunc('if ' + (s.childForFieldName('condition')?.text ?? '')), [], s.childForFieldName('condition') || s);
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
        const cond = mkNode('loop', trunc('while ' + (s.childForFieldName('condition')?.text ?? '')), [], s.childForFieldName('condition') || s);
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
        const cond = mkNode('loop', trunc('while ' + (s.childForFieldName('condition')?.text ?? '')), [], s.childForFieldName('condition') || s);
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
        const cond = mkNode('loop', trunc(header, 46), [], s);
        const breaks = [];
        const br = buildAny(bodyNode, { ...ctx, breaks, continueTo: cond });
        if (br && br.entry) {
          mkEdge(cond, br.entry, 'цикл');
          for (const e of br.exits) mkEdge(e.from, cond, e.label);
        }
        return { entry: cond, exits: [{ from: cond, label: 'конец' }, ...breaks] };
      }

      case 'switch_statement': {
        const sw = mkNode('cond', trunc('switch ' + (s.childForFieldName('condition')?.text ?? '')), [], s.childForFieldName('condition') || s);
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
        if (ctx.continueTo) mkEdge(id, ctx.continueTo, '↩');
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
        const id = mkNode(calls.length ? 'call' : 'stmt', trunc(s.text, 46), calls, s);
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

  // caller classifies by nodes.length (trivial <= 3, oversized > CFG_MAX_NODES)
  // and decides whether to render — so the stacked view can still show a
  // placeholder block for those, keeping the column aligned with the file.
  return { nodes, edges };
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

function cfgToSvg(cfg) {
  const nodeLines = [];
  const edgeLines = [];
  for (const n of cfg.nodes) {
    const label = n.label.split('\n').map(dotEsc).join('<BR/>');
    nodeLines.push(dotNode(n.id, [label], CFG_SHAPE[n.kind] || 'box', CFG_CLASS[n.kind] || 'cfgstmt'));
  }
  // explicit ids (e0, e1, ...) so the webview can select a specific edge
  // element directly instead of relying on graphviz's auto "edgeN" ids, which
  // carry no from/to information.
  cfg.edges.forEach((e, i) => { e.id = 'e' + i; });
  for (const e of cfg.edges) edgeLines.push(dotEdge(e.id, e.from, e.to, e.label));
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

function functionDeclName(fnDefNode) {
  // walk into the declarator to the function_declarator's identifier
  let decl = fnDefNode.childForFieldName('declarator');
  const seen = new Set();
  while (decl && !seen.has(decl.id)) {
    seen.add(decl.id);
    if (decl.type === 'function_declarator') {
      const d = decl.childForFieldName('declarator');
      if (d && d.type === 'identifier') return d.text;
      decl = d;
      continue;
    }
    decl = decl.childForFieldName('declarator') || decl.namedChildren.find((c) => c.type.endsWith('declarator') || c.type === 'identifier');
  }
  return null;
}

function collectFunctions(root) {
  const fns = [];
  walkTree(root, (n) => {
    if (n.type === 'function_definition') {
      fns.push({
        node: n,
        name: functionDeclName(n) || '(anon)',
        startLine: n.startPosition.row,
        endLine: n.endPosition.row,
        body: n.childForFieldName('body'),
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
  const cfg = buildCfg(fn.body);
  const n = cfg.nodes.length;
  if (n <= 3) return { ...base, kind: 'trivial' };
  if (n > CFG_MAX_NODES) return { ...base, kind: 'toobig' };
  const svg = cfgToSvg(cfg); // also assigns e.id on the edges
  return {
    ...base,
    kind: 'cfg',
    svg,
    // per-node line span (0-based, matches VS Code's Position API)
    nodeLines: cfg.nodes
      .filter((x) => x.startLine != null)
      .map((x) => ({ id: x.id, kind: x.kind, startLine: x.startLine, endLine: x.endLine })),
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

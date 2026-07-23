// Webview client — stacked ribbon, deliberately not auto-synced to editor
// scroll (see extension.js for why). Two one-shot actions instead:
//   - click a node here -> extension host jumps the editor to it
//   - host sends 'locate' (from a command run on the cursor's line) -> this
//     scrolls to and highlights the matching node
(function () {
  const vscode = acquireVsCodeApi();
  const viewport = document.getElementById('viewport');
  const inner = document.getElementById('inner');
  const status = document.getElementById('status');
  const otherPlacesEl = document.getElementById('other-places');
  const opTitleEl = otherPlacesEl.querySelector('.op-title');
  const opListEl = otherPlacesEl.querySelector('.op-list');
  const opCloseBtn = document.getElementById('op-close');

  let blocks = []; // one entry per function block, in source order
  // Name from the last symbolSelect/symbolClear message (extension.js, on
  // text-editor selection) — reapplied after every renderAll (edits
  // re-analyze the file and rebuild `blocks` from scratch).
  let lastSymbolName = null;
  // Variable names a DMA channel writes/reads directly (extension.js's
  // 'dmaVars', sourced from the whole-project index) — reapplied after every
  // renderAll for the same reason lastSymbolName is: a fresh analysis
  // rebuilds every .cg-var-token from scratch.
  let dmaVarNames = new Set();

  const KIND_NOTE = {
    trivial: 'тривиальный алгоритм',
    toobig: 'слишком большой для диаграммы',
    none: 'нет тела',
  };

  // A CFG node's text can fold several statements together (see
  // flushBlock in cfg-analyzer.mjs — up to 4 lines per node), and even a
  // single line can name the same variable twice (`x = x + 1;`) — so
  // per-node or per-line click targets aren't precise enough for "show me
  // where else this variable is used" (user request 2026-07-20). Instead,
  // every identifier occurrence becomes its own <tspan>: graphviz already
  // renders each folded line as its own <text> element (one per BR-joined
  // row — verified against actual output, not assumed), so splitting each
  // one on word boundaries into plain-text runs and .cg-var-token <tspan>s
  // is enough; no dot/graphviz-side markup changes needed. Identifier text
  // is always [A-Za-z_]\w* (from tree-sitter), so it's regex-safe as-is —
  // no escaping needed for the alternation below.
  function tokenizeNodeText(g, vars, calls) {
    const names = new Set([...(vars || []), ...(calls || [])]);
    if (!names.size) return;
    const rx = new RegExp('\\b(' + [...names].sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');
    for (const textEl of g.querySelectorAll('text')) {
      const original = textEl.textContent;
      if (!rx.test(original)) continue;
      rx.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = rx.exec(original))) {
        if (m.index > last) frag.appendChild(document.createTextNode(original.slice(last, m.index)));
        const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        tspan.textContent = m[0];
        tspan.setAttribute('class', 'cg-var-token');
        tspan.dataset.varName = m[0];
        frag.appendChild(tspan);
        last = m.index + m[0].length;
      }
      if (last < original.length) frag.appendChild(document.createTextNode(original.slice(last)));
      textEl.textContent = '';
      textEl.appendChild(frag);
    }
  }

  function clearFocus() {
    for (const b of blocks) {
      b.el.classList.remove('active');
      const svg = b.body.querySelector('svg');
      if (svg) svg.classList.remove('dim');
      for (const el of b.body.querySelectorAll('.hl')) el.classList.remove('hl');
    }
  }

  // --- hover-to-path highlighting --------------------------------------------
  // Hovering a CFG node for HOVER_PATH_DELAY_MS dims everything except the
  // branch(es) that can actually reach it — tracing "how do we get here" in a
  // busy diagram otherwise means eyeballing arrows by hand (user request
  // 2026-07-22). Own class triple (path-dim/path-hl/path-hover), independent
  // of .dim/.hl (locate) and .sym-dim/.sym-hl (symbol selection) so the three
  // dimming mechanisms don't fight over the same classes.
  const HOVER_PATH_DELAY_MS = 2000;
  let hoverTimer = null;
  let hoverTimerNodeId = null;  // node the pending timer belongs to
  let hoverPathBlock = null;    // block currently showing a hover-path highlight
  let hoverPathNodeId = null;   // node currently anchoring that highlight

  function clearHoverPath() {
    if (!hoverPathBlock) return;
    const svg = hoverPathBlock.body.querySelector('svg');
    if (svg) svg.classList.remove('path-dim');
    for (const el of hoverPathBlock.nodeEls.values()) el.classList.remove('path-hl', 'path-hover');
    for (const el of hoverPathBlock.edgeEls.values()) el.classList.remove('path-hl');
    hoverPathBlock = null;
    hoverPathNodeId = null;
  }

  // Every node with a directed path to nodeId — reverse BFS over
  // block.predecessors (built from the CFG's real edges, so it naturally
  // follows however many branches actually converge here, loops included).
  function showHoverPath(block, nodeId) {
    const svg = block.body.querySelector('svg');
    if (!svg) return;
    const ancestors = new Set([nodeId]);
    const queue = [nodeId];
    while (queue.length) {
      const cur = queue.pop();
      const preds = block.predecessors.get(cur);
      if (!preds) continue;
      for (const p of preds) {
        if (ancestors.has(p)) continue;
        ancestors.add(p);
        queue.push(p);
      }
    }
    for (const [id, el] of block.nodeEls) if (ancestors.has(id)) el.classList.add('path-hl');
    const hoverEl = block.nodeEls.get(nodeId);
    if (hoverEl) hoverEl.classList.add('path-hover');
    for (const e of block.edgeList) {
      if (!ancestors.has(e.from) || !ancestors.has(e.to)) continue;
      const el = block.edgeEls.get(e.id);
      if (el) el.classList.add('path-hl');
    }
    svg.classList.add('path-dim');
    hoverPathBlock = block;
    hoverPathNodeId = nodeId;
  }

  // mouseenter always clears whatever was showing/pending first, so a leave
  // firing late (after the pointer already entered a different node) never
  // cancels that other node's fresh state — only a leave that belongs to the
  // node currently "owning" the timer/display acts.
  function wireHoverPath(g, block, nodeId) {
    g.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      clearHoverPath();
      hoverTimerNodeId = nodeId;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        hoverTimerNodeId = null;
        showHoverPath(block, nodeId);
      }, HOVER_PATH_DELAY_MS);
    });
    g.addEventListener('mouseleave', () => {
      if (hoverTimerNodeId === nodeId) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
        hoverTimerNodeId = null;
      }
      if (hoverPathNodeId === nodeId) clearHoverPath();
    });
  }

  // --- build the ribbon -----------------------------------------------------
  function renderAll(functions) {
    status.style.display = 'none';
    viewport.style.display = 'block';
    inner.innerHTML = '';
    blocks = [];
    // inner.innerHTML='' above already destroyed any DOM the hover-path
    // machinery was pointing at (or about to fire a pending timer against) —
    // drop the stale references so a leftover timeout can't reach into a
    // detached svg after re-analysis rebuilds the ribbon.
    clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverTimerNodeId = null;
    hoverPathBlock = null;
    hoverPathNodeId = null;

    for (const fn of functions) {
      const el = document.createElement('div');
      el.className = 'fn-block';

      const head = document.createElement('div');
      head.className = 'fn-head';
      head.textContent = fn.functionName;
      head.title = 'Показать «Связи»';
      // Left-click the function's own name (not a CFG node) — opens/updates
      // the «Связи» panel for it. stopPropagation so this doesn't also
      // trigger anything on .fn-block/.viewport (there's no click handler
      // there today, but background-click semantics may grow one later —
      // see main.js's own empty-space-clears-selection handler below).
      head.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'openRelations', functionName: fn.functionName });
      });
      el.appendChild(head);

      const body = document.createElement('div');
      body.className = 'fn-body';

      if (fn.kind === 'cfg' && fn.svg) {
        body.innerHTML = fn.svg;
      } else {
        const note = document.createElement('div');
        note.className = 'fn-note';
        note.textContent = KIND_NOTE[fn.kind] || '—';
        body.appendChild(note);
      }
      el.appendChild(body);
      inner.appendChild(el);

      // cache node elements + line ranges by id (ids repeat across functions
      // — everything here is scoped to this one block)
      const nodeEls = new Map();
      const nodeRange = new Map();
      const nodeMeta = new Map(); // id -> { vars: Set, calls: Set } for symbol highlighting
      const edgeEls = new Map();  // edge id -> its <g class="edge"> element
      const predecessors = new Map(); // node id -> Set(node id that has an edge into it)
      const edgeList = fn.edges || [];
      if (fn.kind === 'cfg') {
        for (const n of fn.nodeLines) {
          const g = body.querySelector(`g.node[id="${n.id}"]`);
          if (g) nodeEls.set(n.id, g);
          nodeRange.set(n.id, { startLine: n.startLine, endLine: n.endLine });
          nodeMeta.set(n.id, { vars: new Set(n.vars || []), calls: new Set(n.calls || []) });
          if (g) tokenizeNodeText(g, n.vars, n.calls);
        }
        for (const e of edgeList) {
          const g = body.querySelector(`g.edge[id="${e.id}"]`);
          if (g) edgeEls.set(e.id, g);
          if (!predecessors.has(e.to)) predecessors.set(e.to, new Set());
          predecessors.get(e.to).add(e.from);
        }
      }
      const block = { el, head, body, funcRange: fn.funcRange, kind: fn.kind, nodeEls, nodeRange, nodeMeta, edgeEls, edgeList, predecessors };
      for (const [id, g] of nodeEls) wireHoverPath(g, block, id);
      blocks.push(block);
    }
    applySymbolHighlight(lastSymbolName);
    applyDmaTagging();
  }

  // Marks every call/var token whose name is a known DMA target (see
  // dmaVarNames above) so main.css can color it purple, same as the
  // periph/DMA blocks in «Уровень 0»/«Связи» — purely a class toggle over
  // whatever tokenizeNodeText already produced, no re-render involved.
  function applyDmaTagging() {
    for (const tok of inner.querySelectorAll('.cg-var-token')) {
      tok.classList.toggle('dma-target', dmaVarNames.has(tok.dataset.varName));
    }
  }

  // Selecting a variable/function name in the editor (extension.js) dims
  // every CFG block across the whole ribbon that doesn't reference it —
  // "reference" meaning calls it, if it's ever seen as a call target
  // anywhere in the ribbon (so foo(bar) always reads as "calls foo", never
  // "uses variable foo" even if some other block also has a local named
  // foo); otherwise plain identifier use. Reuses the .hl/.dim styling
  // 'locate' already established (main.css), but its own class names —
  // sym-hl/sym-dim — so this doesn't fight with locate()'s cursor-driven
  // single-node highlight over the same classes.
  function clearSymbolHighlight() {
    for (const b of blocks) {
      const svg = b.body.querySelector('svg');
      if (svg) svg.classList.remove('sym-dim');
      for (const el of b.nodeEls.values()) el.classList.remove('sym-hl');
    }
  }
  // A name is read as "calls this function" if it's ever seen as a call
  // target anywhere in the ribbon, "uses this variable" otherwise — shared by
  // applySymbolHighlight (below) and showOtherPlaces's "Показать «Связи»"
  // button (only meaningful for a function, not a plain variable).
  function isCallName(name) {
    for (const b of blocks) {
      for (const meta of b.nodeMeta.values()) {
        if (meta.calls.has(name)) return true;
      }
    }
    return false;
  }
  function applySymbolHighlight(name) {
    lastSymbolName = name;
    clearSymbolHighlight();
    if (!name) return;
    const isCall = isCallName(name);
    let any = false;
    for (const b of blocks) {
      if (b.kind !== 'cfg') continue;
      const svg = b.body.querySelector('svg');
      if (!svg) continue;
      for (const [id, meta] of b.nodeMeta) {
        if (isCall ? meta.calls.has(name) : meta.vars.has(name)) {
          any = true;
          const el = b.nodeEls.get(id);
          if (el) el.classList.add('sym-hl');
        }
      }
      svg.classList.add('sym-dim');
    }
    // nothing anywhere references it (e.g. a keyword or type name got
    // selected) — shading everything would just look broken, so don't.
    if (!any) clearSymbolHighlight();
  }

  // --- "other places this variable appears" side list ------------------------
  // Filled in by a separate, later 'symbolOtherPlaces' message (extension.js
  // resolves it against a whole-project scan, which can take a beat) — kept
  // apart from symbolSelect/applySymbolHighlight above so the in-ribbon
  // shading stays instant regardless of that scan's latency. Hidden right
  // away on every new selection so it never shows a stale variable's list
  // while the fresh one is still loading.
  const MODE_LABEL = { r: 'чтение', w: 'запись', rw: 'чтение/запись', decl: 'объявление', call: 'вызов' };

  function hideOtherPlaces() {
    otherPlacesEl.style.display = 'none';
    opListEl.innerHTML = '';
  }
  function showOtherPlaces(name, places) {
    opTitleEl.textContent = `«${name}» также в:`;
    opListEl.innerHTML = '';
    if (!places.length) {
      const info = document.createElement('div');
      info.className = 'op-empty';
      info.textContent = 'больше нигде не найдено';
      opListEl.appendChild(info);
    } else {
      for (const p of places) {
        const item = document.createElement('div');
        item.className = 'op-item';
        item.title = MODE_LABEL[p.mode] || '';
        const fn = document.createElement('span');
        fn.className = 'op-fn';
        fn.textContent = p.name;
        const loc = document.createElement('span');
        loc.className = 'op-loc';
        loc.textContent = `${p.file}:${p.startLine + 1}`;
        item.appendChild(fn);
        item.appendChild(loc);
        item.addEventListener('click', () => {
          vscode.postMessage({ type: 'navigateOther', filePath: p.filePath, startLine: p.startLine });
        });
        opListEl.appendChild(item);
      }
    }
    // usageByVar (the source of `places`) only ever covers variables, so this
    // is the one extra entry point for a function's own "Связи" — right-click
    // wherever it's called, same as it appears anywhere else in the ribbon,
    // rather than requiring a trip to hunt down its own definition block
    // (user request 2026-07-21: the definition-block header alone was too
    // easy to miss/confuse with the CFG node right above it).
    if (isCallName(name)) {
      const relBtn = document.createElement('button');
      relBtn.className = 'op-relations-btn';
      relBtn.textContent = 'Показать «Связи»';
      relBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'openRelations', functionName: name });
      });
      opListEl.appendChild(relBtn);
    }
    otherPlacesEl.style.display = 'block';
  }
  opCloseBtn.addEventListener('click', hideOtherPlaces);

  // --- graph -> code ----------------------------------------------------------
  viewport.addEventListener('click', (ev) => {
    const g = ev.target.closest && ev.target.closest('g.node');
    if (!g || !g.id) {
      // Empty background (or an edge) — release whatever a right-click
      // token or an editor-side selection pinned, same escape hatch as
      // level0's own "click empty space clears the highlight" (user
      // request 2026-07-20). A drag-released pan click never reaches here:
      // setupPanZoom's own capture-phase listener swallows it first.
      applySymbolHighlight(null);
      hideOtherPlaces();
      return;
    }
    const blockEl = ev.target.closest('.fn-block');
    const block = blocks.find((b) => b.el === blockEl);
    if (!block) return;
    const range = block.nodeRange.get(g.id);
    if (!range) return;
    vscode.postMessage({ type: 'navigate', startLine: range.startLine, endLine: range.endLine });
  });

  // Right-click a variable/call token (see tokenizeNodeText above) — same
  // shading as an editor-side selection (applySymbolHighlight), plus a
  // cross-file "other places" lookup, but triggered from the graph itself
  // instead of requiring a trip back to the source to select the name.
  viewport.addEventListener('contextmenu', (ev) => {
    const tok = ev.target.closest && ev.target.closest('.cg-var-token');
    if (!tok) return;
    ev.preventDefault();
    const name = tok.dataset.varName;
    applySymbolHighlight(name);
    hideOtherPlaces();
    vscode.postMessage({ type: 'lookupOtherPlaces', name });
  });

  // --- code -> graph ----------------------------------------------------------
  // scrollIntoView doesn't work once #viewport pans via CSS transform
  // instead of native scroll (see setupPanZoom below) — centerOn pans the
  // shared .inner so the target sits in the middle of the viewport instead.
  function locate(functionStartLine, nodeId) {
    clearFocus();
    const block = blocks.find((b) => b.funcRange.startLine === functionStartLine);
    if (!block) return;
    block.el.classList.add('active');
    const el = nodeId ? block.nodeEls.get(nodeId) : null;
    const target = el || block.el;
    if (el) {
      el.classList.add('hl');
      const svg = block.body.querySelector('svg');
      if (svg) svg.classList.add('dim');
    }
    const box = GraphView.contentBox(viewport, [target]);
    if (box) GraphView.centerOn(viewport, box);
  }

  // --- messages ---------------------------------------------------------------
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'renderAll') {
      renderAll(msg.functions || []);
    } else if (msg.type === 'locate') {
      locate(msg.functionStartLine, msg.nodeId);
    } else if (msg.type === 'symbolSelect') {
      applySymbolHighlight(msg.name);
      hideOtherPlaces(); // fresh selection — wait for this name's own reply
    } else if (msg.type === 'symbolClear') {
      applySymbolHighlight(null);
      hideOtherPlaces();
    } else if (msg.type === 'symbolOtherPlaces') {
      if (msg.name !== lastSymbolName) return; // superseded by a newer selection
      // A right-click lookup (msg.explicit) always confirms something, even
      // "nothing else" — it's a deliberate ask. The passive editor-selection
      // path fires on every identifier you select while reading code, so an
      // empty result there just stays quiet instead of popping up a panel.
      if (msg.explicit || (msg.places && msg.places.length)) showOtherPlaces(msg.name, msg.places || []);
      else hideOtherPlaces();
    } else if (msg.type === 'dmaVars') {
      dmaVarNames = new Set(msg.names || []);
      applyDmaTagging();
    }
  });

  // Wheel = zoom at cursor, left-button drag on empty background = pan
  // (see graph-view.js); the whole ribbon pans/zooms as one canvas, since
  // every function block shares the one #viewport/#inner pair.
  GraphView.setupPanZoom(viewport);
  GraphView.installKeyboardShortcuts();

  vscode.postMessage({ type: 'ready' });
})();

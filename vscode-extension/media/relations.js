// Webview client for the "Связи" panel — one function's caller/callee chain,
// expanded one hop at a time by clicking. Unlike the CLI's web version
// (setupRelationsDiagram in viewer.js), which re-lays-out the chain with
// graphviz-wasm loaded *in the browser*, every click here round-trips to the
// extension host: it rebuilds the dot subgraph against the cached
// workspace-wide relations graph and re-renders via the same Node
// graphviz-wasm every other diagram in this extension uses, then ships back
// a finished SVG. So this file only ever swaps in a new <svg> and wires
// hover/click on it — no local dot-building or re-layout at all.
(function () {
  const vscode = acquireVsCodeApi();
  const status = document.getElementById('status');
  const viewport = document.getElementById('viewport');
  const diagram = document.getElementById('diagram');
  const inner = diagram.querySelector('.inner');
  const varsCheckbox = document.getElementById('vars-toggle');
  const maxBtn = document.getElementById('max-btn');
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomOutBtn = document.getElementById('zoom-out');

  let nodeInfo = {};   // id -> {kind, label, file, filePath, startLine, desc, type, static} (visible nodes only)
  let depthOf = {};    // id -> {side: 'up'|'down', depth} — absent for focus/var/periph (nothing to expand)

  function showStatus(text, isError) {
    viewport.classList.remove('ready');
    status.style.display = 'block';
    status.textContent = text;
    status.classList.toggle('error', !!isError);
  }

  // --- tooltip -----------------------------------------------------------
  // Small self-contained port of graph-view.js's createHoverSystem tip —
  // not reused directly: that system's hover/click model (fade-on-hover,
  // clear-on-leave, one shared 'hl' meaning "currently hovered/pinned") is
  // a different fit than this diagram's, where 'hl' is a *permanent* mark
  // for the confirmed chain and hover needs a separate 'hlring' glow
  // instead (see highlightNode/mark below) — same reason viewer.js keeps
  // wireRelationsNodes entirely separate from its own generic hover setup.
  const KIND_LABEL = {
    fn: 'функция', entry: 'точка входа', isr: 'обработчик прерывания',
    gvar: 'глобальная переменная', gvolatile: 'volatile-глобальная', extvar: 'внешняя переменная',
    periph: 'периферия (регистры)',
  };
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  let lastMouseX = null, lastMouseY = null, tipDirX = 1, tipDirY = 1;
  const TIP_DIR_THRESHOLD = 6;
  function moveTip(ev) {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    if (lastMouseX !== null) {
      const dx = ev.clientX - lastMouseX, dy = ev.clientY - lastMouseY;
      if (Math.abs(dx) >= TIP_DIR_THRESHOLD) tipDirX = dx > 0 ? 1 : -1;
      if (Math.abs(dy) >= TIP_DIR_THRESHOLD) tipDirY = dy > 0 ? 1 : -1;
    }
    lastMouseX = ev.clientX; lastMouseY = ev.clientY;
    let x = tipDirX > 0 ? ev.clientX - r.width - pad : ev.clientX + pad;
    let y = tipDirY > 0 ? ev.clientY - r.height - pad : ev.clientY + pad;
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }
  function showTip(key, ev) {
    const info = nodeInfo[key];
    if (!info) { hideTip(); return; }
    let h = '<div class="k">' + (KIND_LABEL[info.kind] || info.kind) + (info.file ? ' · ' + escHtml(info.file) : '') + '</div>';
    h += '<b>' + escHtml(info.label) + '</b>';
    if (info.type) h += '<div class="sig">' + escHtml(info.type) + (info.static ? ' · static' : '') + '</div>';
    if (info.desc) h += '<div class="d">' + escHtml(info.desc) + '</div>';
    tip.innerHTML = h;
    tip.style.display = 'block';
    moveTip(ev);
  }

  // --- hover/click wiring for one rendered svg ----------------------------
  // Port of viewer.js's wireRelationsNodes: 'hl' marks the confirmed chain
  // (fullColor, set permanently by the host on every render) — hovering an
  // already-'hl' element has no opacity left to gain, so it gets 'hlring'
  // instead; hoverAdded remembers exactly which class hover itself added on
  // each element, so clearing only ever removes that, never a permanent 'hl'.
  function wireSvg(svg) {
    const nodeEls = new Map(); // id -> el
    svg.querySelectorAll('g.node[id]').forEach((el) => { if (nodeInfo[el.id]) nodeEls.set(el.id, el); });
    const edges = [];
    svg.querySelectorAll('g.edge').forEach((el) => {
      const title = el.querySelector('title');
      const parts = title ? title.textContent.split('->') : null;
      GraphView.widenEdgeHitArea(el); // see graph-view.js — thin dashed lines are hard to hover precisely
      if (parts && parts.length === 2 && nodeInfo[parts[0]] && nodeInfo[parts[1]]) {
        edges.push({ el, from: parts[0], to: parts[1] });
      }
    });

    let locked = null;
    const hoverAdded = new Map(); // el -> 'hl' | 'hlring'
    function clearHover() {
      for (const [el, cls] of hoverAdded) el.classList.remove(cls);
      hoverAdded.clear();
    }
    function mark(el) {
      if (!el || hoverAdded.has(el)) return;
      const cls = el.classList.contains('hl') ? 'hlring' : 'hl';
      el.classList.add(cls);
      hoverAdded.set(el, cls);
    }
    function markKey(key) { mark(nodeEls.get(key)); }
    function highlightNode(key) {
      markKey(key);
      for (const e of edges) {
        if (e.from === key || e.to === key) { mark(e.el); markKey(e.from); markKey(e.to); }
      }
    }
    function highlightEdge(e) { mark(e.el); markKey(e.from); markKey(e.to); }

    nodeEls.forEach((el, key) => {
      el.addEventListener('mouseenter', (ev) => {
        showTip(key, ev);
        if (!locked) { clearHover(); highlightNode(key); }
      });
      el.addEventListener('mousemove', (ev) => { if (tip.style.display !== 'none') moveTip(ev); });
      el.addEventListener('mouseleave', () => { hideTip(); if (!locked) clearHover(); });
      el.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        const info = nodeInfo[key];
        if (info && info.filePath && typeof info.startLine === 'number') {
          vscode.postMessage({ type: 'navigate', file: info.filePath, startLine: info.startLine });
        }
      });
      const pos = depthOf[key];
      if (!pos) {
        // focus itself, and every var/periph node — nothing to expand, so a
        // click just locks/unlocks the hover highlight, like any other
        // diagram in this extension.
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (locked === key) { locked = null; clearHover(); return; }
          locked = key;
          clearHover();
          highlightNode(key);
        });
        return;
      }
      // caller/callee node — expand/collapse a hop. The host decides exactly
      // what that means (collapse the deepest pick vs. drill into a new
      // one) using its own copy of the previous depthOf; this side just
      // names which node was clicked.
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'expand', id: key });
      });
    });

    for (const e of edges) {
      const edgeKey = 'edge:' + e.from + '>' + e.to;
      e.el.addEventListener('mouseenter', () => { hideTip(); if (!locked) { clearHover(); highlightEdge(e); } });
      e.el.addEventListener('mouseleave', () => { if (!locked) clearHover(); });
      e.el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (locked === edgeKey) { locked = null; clearHover(); return; }
        locked = edgeKey;
        clearHover();
        highlightEdge(e);
      });
    }
    svg.addEventListener('click', () => { if (locked) { locked = null; clearHover(); } });
  }

  function render(msg) {
    nodeInfo = msg.nodeInfo || {};
    depthOf = msg.depthOf || {};
    varsCheckbox.checked = !!msg.showVars;

    const doc = new DOMParser().parseFromString(msg.svg, 'image/svg+xml');
    const next = document.importNode(doc.documentElement, true);
    next.classList.add('fade'); // permanently faded except the confirmed chain (fullColor) below
    const fullColor = new Set(msg.fullColor || []);
    next.querySelectorAll('g.node[id]').forEach((el) => { if (fullColor.has(el.id)) el.classList.add('hl'); });
    next.querySelectorAll('g.edge').forEach((el) => {
      const title = el.querySelector('title');
      const parts = title ? title.textContent.split('->') : null;
      if (parts && parts.length === 2 && fullColor.has(parts[0]) && fullColor.has(parts[1])) el.classList.add('hl');
    });
    wireSvg(next);

    const old = inner.querySelector('svg');
    if (old) old.replaceWith(next); else inner.appendChild(next);

    status.style.display = 'none';
    viewport.classList.add('ready');
    document.title = msg.title ? `Связи: ${msg.title}` : 'Связи';
  }

  varsCheckbox.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleVars', show: varsCheckbox.checked });
  });
  maxBtn.addEventListener('click', () => GraphView.toggleMaximize(diagram));
  zoomInBtn.addEventListener('click', () => {
    GraphView.applyZoom(diagram, 1.25, diagram.clientWidth / 2, diagram.clientHeight / 2);
  });
  zoomOutBtn.addEventListener('click', () => {
    GraphView.applyZoom(diagram, 0.8, diagram.clientWidth / 2, diagram.clientHeight / 2);
  });

  GraphView.setupPanZoom(diagram);
  GraphView.installKeyboardShortcuts();

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'render') render(msg);
    else if (msg.type === 'status') showStatus(msg.text, false);
    else if (msg.type === 'error') showStatus(msg.text, true);
  });

  vscode.postMessage({ type: 'ready' });
})();

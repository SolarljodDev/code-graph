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

  let blocks = []; // one entry per function block, in source order

  const KIND_NOTE = {
    trivial: 'тривиальный алгоритм',
    toobig: 'слишком большой для диаграммы',
    none: 'нет тела',
  };

  function clearFocus() {
    for (const b of blocks) {
      b.el.classList.remove('active');
      const svg = b.body.querySelector('svg');
      if (svg) svg.classList.remove('dim');
      for (const el of b.body.querySelectorAll('.hl')) el.classList.remove('hl');
    }
  }

  // --- build the ribbon -----------------------------------------------------
  function renderAll(functions) {
    status.style.display = 'none';
    viewport.style.display = 'block';
    inner.innerHTML = '';
    blocks = [];

    for (const fn of functions) {
      const el = document.createElement('div');
      el.className = 'fn-block';

      const head = document.createElement('div');
      head.className = 'fn-head';
      head.textContent = fn.functionName;
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
      if (fn.kind === 'cfg') {
        for (const n of fn.nodeLines) {
          const g = body.querySelector(`g.node[id="${n.id}"]`);
          if (g) nodeEls.set(n.id, g);
          nodeRange.set(n.id, { startLine: n.startLine, endLine: n.endLine });
        }
      }
      blocks.push({ el, head, body, funcRange: fn.funcRange, kind: fn.kind, nodeEls, nodeRange });
    }
  }

  // --- graph -> code ----------------------------------------------------------
  viewport.addEventListener('click', (ev) => {
    const g = ev.target.closest && ev.target.closest('g.node');
    if (!g || !g.id) return;
    const blockEl = ev.target.closest('.fn-block');
    const block = blocks.find((b) => b.el === blockEl);
    if (!block) return;
    const range = block.nodeRange.get(g.id);
    if (!range) return;
    vscode.postMessage({ type: 'navigate', startLine: range.startLine, endLine: range.endLine });
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
    }
  });

  // Wheel = zoom at cursor, left-button drag on empty background = pan
  // (see graph-view.js); the whole ribbon pans/zooms as one canvas, since
  // every function block shares the one #viewport/#inner pair.
  GraphView.setupPanZoom(viewport);
  GraphView.installKeyboardShortcuts();

  vscode.postMessage({ type: 'ready' });
})();

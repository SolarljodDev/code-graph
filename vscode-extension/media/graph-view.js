// Shared graph-view toolkit — pan/zoom, maximize/fit, and a hover-tooltip +
// highlight system, ported from the root project's viewer.js and adapted to
// run inside a VS Code webview (no window.GRAPH/PAGE_EXTRA_NODES globals —
// node info arrives via postMessage and is passed in explicitly instead).
// Classic script (not a module), like main.js — exposes everything on
// window.GraphView so main.js/level0.js can pick only what they need.
//
// Ported, on purpose: engine (dot/fdp) switching, the raw-dot neato-parameter
// debug tester, and the "Связи" diagram's click-to-expand-chain re-layout —
// none of that applies to a VS Code panel.
(function () {
  'use strict';

  // Chrome disables Web Storage for file:// pages; a webview is served from
  // vscode-webview://, where localStorage works fine, but the try/catch is
  // cheap insurance and matches the ported code exactly.
  const memoryStorage = new Map();
  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return memoryStorage.get(key) ?? null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { memoryStorage.set(key, String(value)); }
  }

  // Wires a <details> element's open/closed state to localStorage — used for
  // the level-0 legend, whose explanatory text eats a lot of vertical space
  // once you already know how to read the diagram (user request 2026-07-20).
  // Defaults to open (nothing saved yet) so a first-time user still sees the
  // explanation; only stays collapsed across reloads once someone's actually
  // collapsed it. Native <details>/<summary> instead of custom show/hide JS —
  // free disclosure triangle, keyboard toggling, and no extra state to track
  // beyond persisting the one `open` property the element already has.
  function wirePersistentDetails(details, key) {
    if (!details) return;
    const saved = storageGet(key);
    if (saved !== null) details.open = saved === '1';
    details.addEventListener('toggle', () => {
      storageSet(key, details.open ? '1' : '0');
    });
  }

  // --- pan/zoom ---------------------------------------------------------
  // Position within a diagram is tracked as an explicit translate + scale on
  // .inner rather than native scrollLeft/scrollTop — see viewer.js's own
  // comment: a translate has no floor, so centering content smaller than the
  // viewport just works, where scrollLeft/scrollTop would clamp to 0.
  function getTransform(inner) {
    return {
      z: parseFloat(inner.dataset.z || '1'),
      tx: parseFloat(inner.dataset.tx || '0'),
      ty: parseFloat(inner.dataset.ty || '0'),
    };
  }
  function setTransform(inner, z, tx, ty) {
    inner.dataset.z = z;
    inner.dataset.tx = tx;
    inner.dataset.ty = ty;
    inner.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
  }

  // Zoom the diagram so that the container point (cx, cy) stays fixed.
  function applyZoom(diagram, factor, cx, cy) {
    const inner = diagram.querySelector('.inner');
    if (!inner) return;
    const { z, tx, ty } = getTransform(inner);
    const z2 = Math.min(8, Math.max(0.08, z * factor));
    if (z2 === z) return;
    const ox = inner.offsetLeft, oy = inner.offsetTop;
    const px = (cx - ox - tx) / z;
    const py = (cy - oy - ty) / z;
    setTransform(inner, z2, cx - ox - px * z2, cy - oy - py * z2);
  }

  const DRAG_THRESHOLD = 4; // px of movement before a left-button press becomes a pan

  // Wheel over a diagram zooms at the cursor. Left-button press-and-drag on
  // empty background pans; starting on a node/edge/zoombar is left alone for
  // their own click handlers.
  function setupPanZoom(diagram) {
    diagram.addEventListener('wheel', ev => {
      ev.preventDefault();
      const delta = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY; // lines -> px
      const rect = diagram.getBoundingClientRect();
      applyZoom(diagram, Math.pow(1.0016, -delta), ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });

    let drag = null;
    diagram.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      if (ev.target.closest('g.node, g.edge, .zoombar')) return;
      ev.preventDefault();
      diagram.focus({ preventScroll: true });
      const inner = diagram.querySelector('.inner');
      const { tx, ty } = getTransform(inner);
      drag = { x: ev.clientX, y: ev.clientY, tx, ty, moved: false, id: ev.pointerId };
    });
    diagram.addEventListener('pointermove', ev => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        diagram.setPointerCapture(drag.id);
        diagram.classList.add('panning');
      }
      const inner = diagram.querySelector('.inner');
      const { z } = getTransform(inner);
      setTransform(inner, z, drag.tx + dx, drag.ty + dy);
    });
    const endDrag = (ev) => {
      if (!drag) return;
      if (drag.moved) {
        diagram.classList.remove('panning');
        if (diagram.hasPointerCapture && diagram.hasPointerCapture(drag.id)) {
          diagram.releasePointerCapture(drag.id);
        }
        // Only guard against the release also reading as a click on whatever
        // node/edge it landed on (those have their own click-to-navigate/lock
        // behavior a post-pan release shouldn't retrigger) — pointer capture
        // makes ev.target here always `diagram` itself, so elementFromPoint is
        // needed to find what's actually under the cursor. Plain UI elsewhere
        // in the diagram (a function-name header, empty background) has no
        // such click to protect against, and swallowing indiscriminately there
        // used to eat real clicks after ordinary mouse jitter — any real click
        // has a few px of movement between press and release, which was all
        // it took to cross DRAG_THRESHOLD and mark this a "drag".
        const under = ev && typeof ev.clientX === 'number' ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
        if (under && under.closest('g.node, g.edge')) {
          const swallow = ev2 => { ev2.stopPropagation(); diagram.removeEventListener('click', swallow, true); };
          diagram.addEventListener('click', swallow, true);
        }
      }
      drag = null;
    };
    diagram.addEventListener('pointerup', endDrag);
    diagram.addEventListener('pointercancel', endDrag);
    diagram.addEventListener('dragstart', ev => ev.preventDefault());
    diagram.addEventListener('mousedown', () => diagram.focus({ preventScroll: true }));
  }

  // --- maximize / fit-to-view / keyboard shortcuts -----------------------

  function setMaximized(diagram, on) {
    diagram.classList.toggle('maximized', on);
    document.body.classList.toggle('diagram-maximized', on);
    const btn = diagram.parentElement.querySelector('.maxbtn');
    if (btn) {
      btn.classList.toggle('active', on);
      btn.title = on ? 'Свернуть (Esc)' : 'На весь экран (F)';
    }
  }

  // bounding box (in unscaled .inner content coordinates) enclosing a set of
  // elements, found via their on-screen rects.
  function contentBox(diagram, els) {
    const inner = diagram.querySelector('.inner');
    if (!inner) return null;
    const innerRect = inner.getBoundingClientRect();
    const z = parseFloat(inner.dataset.z || '1');
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      x1 = Math.min(x1, (r.left - innerRect.left) / z);
      y1 = Math.min(y1, (r.top - innerRect.top) / z);
      x2 = Math.max(x2, (r.right - innerRect.left) / z);
      y2 = Math.max(y2, (r.bottom - innerRect.top) / z);
    }
    if (!isFinite(x1)) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // the currently pinned/hovered selection (nodes+edges carrying .hl), or
  // null if nothing is highlighted. Searched across every <svg> under
  // .inner (not just one) — the "Алгоритмы" ribbon holds one <svg> per
  // function block inside a single shared .inner, unlike level 0's lone svg.
  function selectionBox(diagram) {
    const els = diagram.querySelectorAll('.inner .hl');
    return els.length ? contentBox(diagram, els) : null;
  }

  function wholeBox(diagram) {
    const svgs = diagram.querySelectorAll('.inner svg');
    return svgs.length ? contentBox(diagram, svgs) : null;
  }

  function fitToView(diagram, box) {
    const inner = diagram.querySelector('.inner');
    if (!inner || !box || box.w <= 0 || box.h <= 0) return;
    const margin = 0.92;
    const z2 = Math.min(8, Math.max(0.08,
      Math.min(diagram.clientWidth / box.w, diagram.clientHeight / box.h) * margin));
    const ox = inner.offsetLeft, oy = inner.offsetTop;
    const tx = diagram.clientWidth / 2 - ox - (box.x + box.w / 2) * z2;
    const ty = diagram.clientHeight / 2 - oy - (box.y + box.h / 2) * z2;
    setTransform(inner, z2, tx, ty);
  }

  // Pan .inner so box's center aligns with the viewport center, WITHOUT
  // changing zoom (unlike fitToView) — used in place of native
  // scrollIntoView, which stops working once a diagram pans via transform
  // instead of the browser's own scroll.
  function centerOn(diagram, box) {
    const inner = diagram.querySelector('.inner');
    if (!inner || !box) return;
    const { z } = getTransform(inner);
    const ox = inner.offsetLeft, oy = inner.offsetTop;
    const tx = diagram.clientWidth / 2 - ox - (box.x + box.w / 2) * z;
    const ty = diagram.clientHeight / 2 - oy - (box.y + box.h / 2) * z;
    setTransform(inner, z, tx, ty);
  }

  function homeFit(diagram) {
    fitToView(diagram, selectionBox(diagram) || wholeBox(diagram));
  }

  function toggleMaximize(diagram) {
    setMaximized(diagram, !diagram.classList.contains('maximized'));
    homeFit(diagram);
    diagram.focus({ preventScroll: true });
  }

  // F/Home/Escape only act on a diagram that currently holds focus. Safe to
  // call once per panel (each webview panel is its own document — there's
  // no cross-panel double-registration to guard against).
  function installKeyboardShortcuts() {
    document.addEventListener('keydown', ev => {
      const active = document.activeElement;
      const diagram = active && active.closest && active.closest('.diagram');
      if (!diagram) return;
      if (ev.key === 'Escape') {
        if (diagram.classList.contains('maximized')) { ev.preventDefault(); setMaximized(diagram, false); }
      } else if (ev.key === 'f' || ev.key === 'F') {
        ev.preventDefault();
        toggleMaximize(diagram);
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        homeFit(diagram);
      }
    });
  }

  // --- hover tooltip + highlight ------------------------------------------

  // An SVG path with fill="none" only hit-tests its actually-painted stroke
  // — for a dashed edge (stroke-dasharray) that's the dash segments alone,
  // not the gaps between them, and the whole line is often just ~1px wide
  // to begin with. In practice that means a good fraction of careful,
  // deliberate hover attempts land in a gap or just off the line and
  // silently do nothing — no cursor change, no highlight, nothing to tell
  // you why (user report 2026-07-21: "I really did hover over it and there
  // was no caption at all"). Standard SVG fix: a wider, solid, fully
  // transparent duplicate path laid over the real one purely for hit-testing
  // — invisible, but hovering anywhere within its fatter stroke still
  // triggers the *edge group's* own mouseenter/mouseleave (attached to the
  // <g>, not this path specifically), so no listener wiring changes needed
  // elsewhere. Node hit-testing has no equivalent problem: their shapes are
  // filled, not just stroked, so the whole interior already counts as paint.
  const EDGE_HIT_STROKE_WIDTH = 10;
  function widenEdgeHitArea(edgeGroup) {
    const path = edgeGroup.querySelector('path');
    if (!path) return;
    const hit = path.cloneNode(false);
    hit.removeAttribute('stroke-dasharray');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
    hit.setAttribute('fill', 'none');
    // Presentation attributes alone aren't enough — graph-view.css's own
    // `svg g.edge path { stroke: var(--vscode-foreground); }` (an ordinary
    // author rule) outranks a bare attribute in the cascade and paints this
    // "invisible" duplicate solid and visible, and `svg g.edge.hl path
    // { stroke-width: 2.5px !important }` would shrink its hoverable width
    // the instant hover starts — ending the hover, which restores the width,
    // which restarts hover, forever (both bugs from user report 2026-07-21).
    // This class is how graph-view.css opts it out of both.
    hit.setAttribute('class', 'edge-hit');
    path.after(hit);
  }

  const DEFAULT_KIND_LABEL = {
    fn: 'функция', entry: 'точка входа', isr: 'обработчик прерывания',
    gvar: 'глобальная переменная', gvolatile: 'volatile-глобальная',
    extfn: 'внешняя функция / макрос', extvar: 'внешняя переменная', file: 'файл',
    periph: 'периферия (регистры)',
  };

  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // nodeInfoFor(key) replaces viewer.js's window.GRAPH/PAGE_EXTRA_NODES
  // lookup — data arrives via postMessage instead of a static graph-data.js.
  // onNavigate(key, info) replaces hrefFor+location.href — the caller
  // decides what "navigate" means (postMessage to the extension host, here).
  function createHoverSystem({ nodeInfoFor, onNavigate, kindLabel = DEFAULT_KIND_LABEL }) {
    const tip = document.createElement('div');
    tip.className = 'tip';
    document.body.appendChild(tip);

    function tipHtml(info) {
      let h = '<div class="k">' + (kindLabel[info.kind] || info.kind) + (info.file ? ' · ' + escHtml(info.file) : '') + '</div>';
      h += '<b>' + escHtml(info.label) + '</b>';
      if (info.sig) h += '<div class="sig">' + escHtml(info.sig) + '</div>';
      if (info.type) {
        h += '<div class="sig">' + escHtml(info.type) +
          (info.static ? ' · static' : '') + (info.volatile ? ' · volatile' : '') + '</div>';
      }
      if (info.desc) h += '<div class="d">' + escHtml(info.desc) + '</div>';
      if (info.users) h += '<div class="k">используют: ' + info.users + ' функц.</div>';
      if (info.writers && info.writers.length) h += '<div class="k">пишут: ' + escHtml(info.writers.join(', ')) + '</div>';
      if (info.readers && info.readers.length) h += '<div class="k">читают: ' + escHtml(info.readers.join(', ')) + '</div>';
      if (info.armers && info.armers.length) h += '<div class="k">взводят прерывание: ' + escHtml(info.armers.join(', ')) + '</div>';
      if (info.isrTargets && info.isrTargets.length) h += '<div class="k">вызывает обработчики: ' + escHtml(info.isrTargets.join(', ')) + '</div>';
      return h;
    }

    let lastMouseX = null, lastMouseY = null;
    let tipDirX = 1, tipDirY = 1;
    const TIP_DIR_THRESHOLD = 6;
    function moveTip(ev) {
      const pad = 14;
      const r = tip.getBoundingClientRect();
      if (lastMouseX !== null) {
        const dx = ev.clientX - lastMouseX, dy = ev.clientY - lastMouseY;
        if (Math.abs(dx) >= TIP_DIR_THRESHOLD) tipDirX = dx > 0 ? 1 : -1;
        if (Math.abs(dy) >= TIP_DIR_THRESHOLD) tipDirY = dy > 0 ? 1 : -1;
      }
      lastMouseX = ev.clientX;
      lastMouseY = ev.clientY;
      let x = tipDirX > 0 ? ev.clientX - r.width - pad : ev.clientX + pad;
      let y = tipDirY > 0 ? ev.clientY - r.height - pad : ev.clientY + pad;
      x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
      y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }

    function hideTip() { tip.style.display = 'none'; }
    function showTip(key, ev) {
      const info = nodeInfoFor(key);
      if (!info) { hideTip(); return; }
      tip.innerHTML = tipHtml(info);
      tip.style.display = 'block';
      moveTip(ev);
    }

    // Every diagram ships as an already-laid-out graphviz SVG: our own ids
    // are already the SVG ids, and edges carry their endpoints in a
    // <title>from-&gt;to</title>.
    function setupGraphvizSvg(svg) {
      const nodeEls = new Map();
      svg.querySelectorAll('g.node[id]').forEach(el => {
        if (nodeInfoFor(el.id)) nodeEls.set(el.id, [el]);
      });

      const edges = [];
      svg.querySelectorAll('g.edge').forEach(el => {
        const title = el.querySelector('title');
        const parts = title ? title.textContent.split('->') : null;
        if (parts && parts.length === 2) edges.push({ el, from: parts[0], to: parts[1] });
        widenEdgeHitArea(el);
      });

      let locked = null;
      function clearHighlight() {
        svg.classList.remove('fade');
        svg.querySelectorAll('.hl').forEach(el => el.classList.remove('hl'));
      }
      function highlightNode(key) {
        svg.classList.add('fade');
        const on = new Set([key]);
        for (const e of edges) {
          if (e.from === key || e.to === key) {
            e.el.classList.add('hl');
            on.add(e.from);
            on.add(e.to);
          }
        }
        for (const k of on) (nodeEls.get(k) || []).forEach(el => el.classList.add('hl'));
      }
      function highlightEdge(e) {
        svg.classList.add('fade');
        e.el.classList.add('hl');
        [e.from, e.to].forEach(k => (nodeEls.get(k) || []).forEach(el => el.classList.add('hl')));
      }

      for (const [key, els] of nodeEls) {
        for (const el of els) {
          el.addEventListener('mouseenter', ev => {
            showTip(key, ev);
            if (locked) return;
            clearHighlight();
            highlightNode(key);
          });
          el.addEventListener('mousemove', ev => {
            if (tip.style.display !== 'none') moveTip(ev);
          });
          el.addEventListener('mouseleave', () => {
            hideTip();
            if (!locked) clearHighlight();
          });
          el.addEventListener('click', ev => {
            ev.stopPropagation();
            if (locked === key) { locked = null; clearHighlight(); return; }
            locked = key;
            clearHighlight();
            highlightNode(key);
          });
          el.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            if (onNavigate) onNavigate(key, nodeInfoFor(key));
          });
        }
      }
      for (const e of edges) {
        const edgeKey = 'edge:' + e.from + '>' + e.to;
        e.el.addEventListener('mouseenter', () => {
          hideTip();
          if (locked) return;
          clearHighlight();
          highlightEdge(e);
        });
        e.el.addEventListener('mouseleave', () => { if (!locked) clearHighlight(); });
        e.el.addEventListener('click', ev => {
          ev.stopPropagation();
          if (locked === edgeKey) { locked = null; clearHighlight(); return; }
          locked = edgeKey;
          clearHighlight();
          highlightEdge(e);
        });
      }
      svg.addEventListener('click', () => { if (locked) { locked = null; clearHighlight(); } });

      // External driver (code-selection shading, see level0.js) — plays by
      // the same "locked" rule as a manual click-pin: hover elsewhere is
      // ignored while it holds, and clicking empty background releases it,
      // same as clicking a pinned node again.
      return {
        selectExternal(key) {
          if (!nodeEls.has(key)) { this.clearExternal(); return false; }
          locked = key;
          clearHighlight();
          highlightNode(key);
          return true;
        },
        clearExternal() {
          if (locked) { locked = null; clearHighlight(); }
        },
      };
    }

    return { setupGraphvizSvg, hideTip };
  }

  window.GraphView = {
    storageGet, storageSet, wirePersistentDetails,
    getTransform, setTransform, applyZoom, setupPanZoom,
    contentBox, wholeBox, selectionBox, fitToView, homeFit, centerOn,
    setMaximized, toggleMaximize, installKeyboardShortcuts,
    createHoverSystem, widenEdgeHitArea,
  };
})();

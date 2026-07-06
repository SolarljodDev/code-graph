/* Runtime for generated pages (copied into the output as app.js).
   Renders mermaid diagrams with the ELK layout engine, then adds:
   - hover highlighting: a node lights up together with every edge from/to it
     and its direct neighbors, everything else fades;
   - a tooltip near the cursor fed from graph-data.js (window.GRAPH). */
(function () {
  'use strict';

  // Zoom the diagram so that the container point (cx, cy) stays fixed:
  // convert it to content coordinates at the old scale, rescale, then scroll
  // the container so the same content point is back under (cx, cy).
  function applyZoom(diagram, factor, cx, cy) {
    const inner = diagram.querySelector('.inner');
    if (!inner) return;
    const z = parseFloat(inner.dataset.z || '1');
    const z2 = Math.min(8, Math.max(0.08, z * factor));
    if (z2 === z) return;
    const ox = inner.offsetLeft, oy = inner.offsetTop; // zoombar sits above .inner
    const px = (diagram.scrollLeft + cx - ox) / z;
    const py = (diagram.scrollTop + cy - oy) / z;
    inner.dataset.z = z2;
    inner.style.transform = 'scale(' + z2 + ')';
    diagram.scrollLeft = px * z2 + ox - cx;
    diagram.scrollTop = py * z2 + oy - cy;
  }

  window.zoom = function (btn, factor) {
    const d = btn.closest('.diagram');
    applyZoom(d, factor, d.clientWidth / 2, d.clientHeight / 2);
  };

  const DRAG_THRESHOLD = 4; // px of movement before a left-button press becomes a pan

  // Wheel over a diagram zooms at the cursor (the page scrolls only when the
  // cursor is outside). Left-button press-and-drag on empty background pans;
  // starting on a node/edge/zoombar is left alone for their own click handlers.
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
      if (ev.target.closest('g.node, .edgePaths, .edgeLabels, .zoombar')) return;
      // stop the browser's native text/element drag-selection from starting —
      // otherwise a press-drag that happens to start over an SVG text node
      // paints a selection instead of (or as well as) panning
      ev.preventDefault();
      drag = { x: ev.clientX, y: ev.clientY, sl: diagram.scrollLeft, st: diagram.scrollTop, moved: false, id: ev.pointerId };
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
      diagram.scrollLeft = drag.sl - dx;
      diagram.scrollTop = drag.st - dy;
    });
    const endDrag = () => {
      if (!drag) return;
      if (drag.moved) {
        diagram.classList.remove('panning');
        if (diagram.hasPointerCapture && diagram.hasPointerCapture(drag.id)) {
          diagram.releasePointerCapture(drag.id);
        }
        // the drag ends with a click event on whatever's under the cursor;
        // swallow just that one so it doesn't also lock/unlock a highlight
        const swallow = ev2 => { ev2.stopPropagation(); diagram.removeEventListener('click', swallow, true); };
        diagram.addEventListener('click', swallow, true);
      }
      drag = null;
    };
    diagram.addEventListener('pointerup', endDrag);
    diagram.addEventListener('pointercancel', endDrag);
    // belt-and-braces: some browsers fire a native dragstart for SVG content
    // even with user-select:none and preventDefault() on pointerdown
    diagram.addEventListener('dragstart', ev => ev.preventDefault());
  }

  const KIND_LABEL = {
    fn: 'функция', entry: 'точка входа', isr: 'обработчик прерывания',
    gvar: 'глобальная переменная', gvolatile: 'volatile-глобальная',
    extfn: 'внешняя функция / макрос', extvar: 'внешняя переменная', file: 'файл',
    periph: 'периферия (регистры)',
  };

  function nodes() { return (window.GRAPH && window.GRAPH.nodes) || {}; }

  // Node ids known on the current page: graph-data.js entries (functions,
  // globals, files — shared across all pages, hrefs stored root-relative)
  // plus this page's own CFG-diagram call-node links, if any (ids like "c3"
  // are only unique within one function's flowchart, so they can't live in
  // the shared graph-data.js — each function page gets its own CFG_LINKS).
  function knownKeys() {
    const s = new Set(Object.keys(nodes()));
    if (window.CFG_LINKS) for (const k of Object.keys(window.CFG_LINKS)) s.add(k);
    return s;
  }

  function hrefFor(key) {
    const info = nodes()[key];
    const href = (info && info.href) || (window.CFG_LINKS && window.CFG_LINKS[key]);
    return href ? (window.PAGE_REL || '') + href : null;
  }

  // mermaid v11 node ids look like: mermaid-<ts>-flowchart-<ourId>-<n>
  function nodeKeyFromDomId(domId, known) {
    if (known.has(domId)) return domId;
    let m = domId.match(/flowchart-(.+?)-\d+$/);
    if (m && known.has(m[1])) return m[1];
    m = domId.match(/^(.+?)-\d+$/);
    if (m && known.has(m[1])) return m[1];
    return null;
  }

  // mermaid v11 edge paths carry data-id="L_<from>_<to>_<n>"; older versions
  // used LS-/LE- classes. Both endpoint ids may contain underscores, so the
  // L_ form is resolved against the known node-id list.
  function edgeEndpoints(el, known) {
    let from = null, to = null;
    for (const c of el.classList) {
      if (c.indexOf('LS-') === 0) from = c.slice(3);
      if (c.indexOf('LE-') === 0) to = c.slice(3);
    }
    if (from && to) return [from, to];
    const raw = (el.dataset && el.dataset.id) || el.id || '';
    const id = raw.replace(/^mermaid-\d+-/, '');
    if (id.indexOf('L_') === 0) {
      const body = id.slice(2).replace(/_\d+$/, '');
      for (const a of known) {
        if (body.indexOf(a + '_') === 0) {
          const b = body.slice(a.length + 1);
          if (known.has(b)) return [a, b];
        }
      }
    }
    return null;
  }

  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const tip = document.createElement('div');
  tip.className = 'tip';

  function tipHtml(info) {
    const esc = escHtml;
    let h = '<div class="k">' + (KIND_LABEL[info.kind] || info.kind) + (info.file ? ' · ' + esc(info.file) : '') + '</div>';
    h += '<b>' + esc(info.label) + '</b>';
    if (info.sig) h += '<div class="sig">' + esc(info.sig) + '</div>';
    if (info.type) {
      h += '<div class="sig">' + esc(info.type) +
        (info.static ? ' · static' : '') + (info.volatile ? ' · volatile' : '') + '</div>';
    }
    if (info.desc) h += '<div class="d">' + esc(info.desc) + '</div>';
    if (info.users) h += '<div class="k">используют: ' + info.users + ' функц.</div>';
    if (info.writers && info.writers.length) h += '<div class="k">пишут: ' + esc(info.writers.join(', ')) + '</div>';
    if (info.readers && info.readers.length) h += '<div class="k">читают: ' + esc(info.readers.join(', ')) + '</div>';
    if (info.armers && info.armers.length) h += '<div class="k">взводят прерывание: ' + esc(info.armers.join(', ')) + '</div>';
    if (info.isrTargets && info.isrTargets.length) h += '<div class="k">вызывает обработчики: ' + esc(info.isrTargets.join(', ')) + '</div>';
    return h;
  }

  function moveTip(ev) {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function setupSvg(svg, opts) {
    opts = opts || {};
    const onNodeClick = opts.onNodeClick; // (key, ev) => true if it handled the click itself
    const G = nodes();
    const known = knownKeys();
    if (opts.extraKeys) for (const k of opts.extraKeys) known.add(k);
    const nodeEls = new Map(); // graph key -> [dom elements]
    svg.querySelectorAll('g.node[id]').forEach(el => {
      const key = nodeKeyFromDomId(el.id, known);
      if (!key) return;
      if (!nodeEls.has(key)) nodeEls.set(key, []);
      nodeEls.get(key).push(el);
    });

    const paths = Array.from(svg.querySelectorAll('.edgePaths path, path.flowchart-link'));
    const labels = Array.from(svg.querySelectorAll('.edgeLabels .edgeLabel'));
    const pairLabels = labels.length === paths.length;
    const edges = [];
    paths.forEach((el, i) => {
      const ep = edgeEndpoints(el, known);
      if (ep) edges.push({ el, labelEl: pairLabels ? labels[i] : null, from: ep[0], to: ep[1] });
    });

    // null = following the hover; a string = a node/edge click has pinned
    // the highlight so moving the mouse over other elements does nothing,
    // until the user clicks empty background to release it. The tooltip is
    // deliberately NOT part of what's pinned — it always tracks genuine
    // hover, or it's left behind as a stale box once the cursor moves away.
    let locked = null;

    function hideTip() { tip.style.display = 'none'; }

    function clearHighlight() {
      svg.classList.remove('fade');
      svg.querySelectorAll('.hl').forEach(el => el.classList.remove('hl'));
    }

    function showTip(key, ev) {
      const info = G[key];
      if (!info) { hideTip(); return; }
      tip.innerHTML = tipHtml(info);
      tip.style.display = 'block';
      moveTip(ev);
    }

    function highlightNode(key) {
      svg.classList.add('fade');
      const on = new Set([key]);
      for (const e of edges) {
        if (e.from === key || e.to === key) {
          e.el.classList.add('hl');
          if (e.labelEl) e.labelEl.classList.add('hl');
          on.add(e.from);
          on.add(e.to);
        }
      }
      for (const k of on) (nodeEls.get(k) || []).forEach(el => el.classList.add('hl'));
    }

    function highlightEdge(e) {
      svg.classList.add('fade');
      e.el.classList.add('hl');
      if (e.labelEl) e.labelEl.classList.add('hl');
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
          if (onNodeClick && onNodeClick(key, ev)) return; // e.g. a group placeholder expanding in place
          if (locked === key) { locked = null; clearHighlight(); return; } // click again: unlock
          locked = key;
          clearHighlight();
          highlightNode(key);
        });
        el.addEventListener('dblclick', ev => {
          ev.stopPropagation();
          const href = hrefFor(key);
          if (href) window.location.href = href;
        });
      }
    }
    for (const e of edges) {
      const edgeKey = 'edge:' + e.from + '>' + e.to;
      e.el.addEventListener('mouseenter', () => {
        hideTip(); // edges carry no tooltip info of their own
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
    // click on empty background (bubbled up, not stopped by a node/edge handler)
    svg.addEventListener('click', () => { if (locked) { locked = null; clearHighlight(); } });
  }

  // A "grouped" file diagram ships fully collapsed (one grey placeholder per
  // neighboring file / variable-importance tier) plus a hidden JSON blob with
  // everything needed to expand any single group in place: clicking a
  // placeholder recomposes the mermaid source with that group's real nodes
  // swapped in and re-renders — nothing was ever deleted, just folded up.
  function setupGroupedDiagram(diagram) {
    const script = diagram.querySelector('script.group-data');
    if (!script) return null;
    let data;
    try { data = JSON.parse(script.textContent); } catch (e) { return null; }
    const expanded = new Set();
    const groupById = new Map(data.groups.map(g => [g.id, g]));

    function compose() {
      const parts = ['flowchart LR', ...data.classDefs.map(c => '  ' + c), ...data.baseLines];
      for (const g of data.groups) {
        if (g.kind === 'list') {
          // same node id and the same edges either way — only its own label
          // text changes, so opening/closing one never reflows anything else
          parts.push(expanded.has(g.id) ? g.fullLine : g.phLine, ...g.edges);
        } else if (expanded.has(g.id)) {
          parts.push(...g.realLines, ...g.expandedEdges);
        } else {
          parts.push(g.phLine, ...g.collapsedEdges);
        }
      }
      return parts.join('\n');
    }

    function wire(svg) {
      if (!svg) return;
      setupSvg(svg, {
        extraKeys: groupById.keys(),
        onNodeClick(key) {
          const g = groupById.get(key);
          if (!g) return false;
          if (g.kind === 'list') {
            if (expanded.has(key)) expanded.delete(key);
            else expanded.add(key);
          } else {
            if (expanded.has(key)) return false; // function groups only ever expand forward
            expanded.add(key);
          }
          rerender();
          return true;
        },
      });
    }

    async function rerender() {
      const inner = diagram.querySelector('.inner');
      const old = inner.querySelector('svg, pre');
      const pre = document.createElement('pre');
      pre.className = 'mermaid';
      pre.textContent = compose();
      old.replaceWith(pre);
      try {
        await mermaid.run({ nodes: [pre] });
      } catch (e) {
        console.error('mermaid render (group expand):', e);
        return;
      }
      wire(diagram.querySelector('svg'));
    }

    // the first pass is already-rendered (fully collapsed) by the normal
    // mermaid.run over .mermaid — just wire clicks onto it, no re-render
    return wire;
  }

  // Explorer-style navigation history: every page visited extends the trail;
  // landing on a page already in the trail (breadcrumb click, browser Back)
  // truncates back to it instead of appending a duplicate.
  function updateTrail() {
    const path = window.PAGE_PATH;
    if (!path) return null;
    let trail = [];
    try { trail = JSON.parse(sessionStorage.getItem('cg_trail') || '[]'); } catch (e) { /* ignore */ }
    const idx = trail.findIndex(t => t.href === path);
    if (idx >= 0) trail = trail.slice(0, idx + 1);
    else trail.push({ href: path, title: window.PAGE_TITLE || path });
    try { sessionStorage.setItem('cg_trail', JSON.stringify(trail)); } catch (e) { /* ignore */ }
    return trail;
  }

  function renderTrail(trail) {
    if (!trail || !trail.length) return;
    const rel = window.PAGE_REL || '';
    const bar = document.createElement('div');
    bar.className = 'trailbar';
    bar.innerHTML = trail.map((t, i) => {
      const label = escHtml(t.title);
      return i === trail.length - 1
        ? '<span class="cur">' + label + '</span>'
        : '<a href="' + rel + t.href + '">' + label + '</a>';
    }).join('<span class="sep">&rsaquo;</span>');
    const main = document.querySelector('main');
    if (main) main.insertBefore(bar, main.firstChild);
  }

  window.addEventListener('DOMContentLoaded', async () => {
    renderTrail(updateTrail());
    document.body.appendChild(tip);
    document.querySelectorAll('.diagram').forEach(setupPanZoom);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      layout: 'elk',
      // NETWORK_SIMPLEX packs nodes noticeably tighter than BRANDES_KOEPF on
      // large graphs (less empty space between layers)
      elk: { nodePlacementStrategy: 'NETWORK_SIMPLEX' },
      flowchart: { useMaxWidth: false, htmlLabels: true },
      maxTextSize: 2000000,
      maxEdges: 5000,
    });
    try {
      await mermaid.run({ querySelector: '.mermaid' });
    } catch (e) {
      console.error('mermaid render:', e);
    }
    document.querySelectorAll('.diagram[data-groups="true"]').forEach(d => {
      const wire = setupGroupedDiagram(d);
      if (wire) wire(d.querySelector('svg'));
    });
    document.querySelectorAll('.diagram:not([data-groups="true"]) svg').forEach(el => setupSvg(el));

    // diagrams inside <details> render lazily on open: hidden elements
    // measure text incorrectly, so they carry class "mermaid-lazy" until then
    document.querySelectorAll('details').forEach(d => {
      d.addEventListener('toggle', async () => {
        if (!d.open) return;
        const lazies = Array.from(d.querySelectorAll('pre.mermaid-lazy'));
        if (!lazies.length) return;
        for (const el of lazies) {
          el.classList.remove('mermaid-lazy');
          el.classList.add('mermaid');
        }
        try {
          await mermaid.run({ nodes: lazies });
        } catch (e) {
          console.error('mermaid render (lazy):', e);
        }
        d.querySelectorAll('.diagram svg').forEach(setupSvg);
      });
    });
  });
})();

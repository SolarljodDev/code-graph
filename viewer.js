/* Runtime for generated pages (copied into the output as app.js).
   Every diagram ships as an already-laid-out graphviz SVG, computed at
   build time (index.mjs) — this file only adds interactivity on top:
   - pan/zoom/maximize on the pre-rendered SVG;
   - hover highlighting: a node lights up together with every edge from/to it
     and its direct neighbors, everything else fades;
   - a tooltip near the cursor fed from graph-data.js (window.GRAPH);
   - per-diagram engine switching (dot/neato/fdp) and a variables toggle,
     both instant since every engine's SVG is already pre-built. */
(function () {
  'use strict';

  // Chrome disables Web Storage for file:// pages by default (this tool's
  // primary way of being opened — "open index.html in a browser", no server
  // needed), so localStorage.setItem throws there. A dropdown's change
  // handler that does `localStorage.setItem(...); onChange(...)` silently
  // never reaches onChange when that throws — the setting just looks inert.
  // Falling back to an in-memory Map keeps the current tab's picks working
  // even when nothing can persist across reloads.
  const memoryStorage = new Map();
  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return memoryStorage.get(key) ?? null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { memoryStorage.set(key, String(value)); }
  }

  // Position within a diagram is tracked as an explicit translate + scale on
  // .inner rather than via native scrollLeft/scrollTop: scrollLeft/scrollTop
  // can never go negative, so centering content that's smaller than the
  // viewport (e.g. a tall, narrow graph scaled down to fit) used to clamp to
  // 0 and leave it flush against the left/top edge instead of centered.
  // A translate has no such floor, so centering and panning both just work.
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

  // Zoom the diagram so that the container point (cx, cy) stays fixed:
  // convert it to content coordinates at the old scale, rescale, then
  // translate so the same content point is back under (cx, cy).
  function applyZoom(diagram, factor, cx, cy) {
    const inner = diagram.querySelector('.inner');
    if (!inner) return;
    const { z, tx, ty } = getTransform(inner);
    const z2 = Math.min(8, Math.max(0.08, z * factor));
    if (z2 === z) return;
    const ox = inner.offsetLeft, oy = inner.offsetTop; // zoombar sits above .inner
    const px = (cx - ox - tx) / z;
    const py = (cy - oy - ty) / z;
    setTransform(inner, z2, cx - ox - px * z2, cy - oy - py * z2);
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
      if (ev.target.closest('g.node, g.edge, .zoombar')) return;
      // stop the browser's native text/element drag-selection from starting —
      // otherwise a press-drag that happens to start over an SVG text node
      // paints a selection instead of (or as well as) panning
      ev.preventDefault();
      // preventDefault() above suppresses the compatibility mousedown event
      // this pointerdown would otherwise trigger, so the mousedown-based
      // focus listener below never fires for clicks on empty background —
      // focus here directly so F/Home/Escape still target this diagram
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

    // focus follows any interaction with this diagram (click on a node,
    // drag-pan, or the maximize button) so the F/Home/Escape shortcuts below
    // know which diagram they apply to
    diagram.addEventListener('mousedown', () => diagram.focus({ preventScroll: true }));
  }

  // --- maximize to the full browser window (not the Fullscreen API — the
  // tab strip and everything above it stays visible) + Home-to-fit-selection ---

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
  // elements, found via their on-screen rects so nested SVG/HTML transforms
  // never need to be untangled by hand
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
  // null if nothing is highlighted right now
  function selectionBox(diagram) {
    const svg = diagram.querySelector('svg');
    if (!svg) return null;
    const els = svg.querySelectorAll('.hl');
    return els.length ? contentBox(diagram, els) : null;
  }

  function wholeBox(diagram) {
    const svg = diagram.querySelector('svg');
    return svg ? contentBox(diagram, [svg]) : null;
  }

  function fitToView(diagram, box) {
    const inner = diagram.querySelector('.inner');
    if (!inner || !box || box.w <= 0 || box.h <= 0) return;
    const margin = 0.92; // small breathing room around the fitted box
    const z2 = Math.min(8, Math.max(0.08,
      Math.min(diagram.clientWidth / box.w, diagram.clientHeight / box.h) * margin));
    const ox = inner.offsetLeft, oy = inner.offsetTop;
    const tx = diagram.clientWidth / 2 - ox - (box.x + box.w / 2) * z2;
    const ty = diagram.clientHeight / 2 - oy - (box.y + box.h / 2) * z2;
    setTransform(inner, z2, tx, ty);
  }

  // Home: fit the current selection if there is one, else fit everything
  function homeFit(diagram) {
    fitToView(diagram, selectionBox(diagram) || wholeBox(diagram));
  }

  window.toggleMaximize = function (btn) {
    // btn's own parent is .diagram-toolbar for a graphviz diagram (or
    // .diagram-wrap directly for a plain one) — .diagram-wrap is the
    // reliable common ancestor to search from either way
    const diagram = btn.closest('.diagram-wrap').querySelector('.diagram');
    setMaximized(diagram, !diagram.classList.contains('maximized'));
    homeFit(diagram);
    // the button lives outside .diagram, so a native click doesn't leave
    // focus on it the way clicking inside the diagram would — force it so
    // Escape/F/Home immediately recognize this diagram as active
    diagram.focus({ preventScroll: true });
  };

  // F/Home/Escape only act on a diagram that was clicked into or otherwise
  // holds focus, so typing elsewhere on the page never triggers them
  document.addEventListener('keydown', ev => {
    const active = document.activeElement;
    const diagram = active && active.closest && active.closest('.diagram');
    if (!diagram) return;
    if (ev.key === 'Escape') {
      if (diagram.classList.contains('maximized')) { ev.preventDefault(); setMaximized(diagram, false); }
    } else if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault();
      setMaximized(diagram, !diagram.classList.contains('maximized'));
      homeFit(diagram);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      homeFit(diagram);
    }
  });

  const KIND_LABEL = {
    fn: 'функция', entry: 'точка входа', isr: 'обработчик прерывания',
    gvar: 'глобальная переменная', gvolatile: 'volatile-глобальная',
    extfn: 'внешняя функция / макрос', extvar: 'внешняя переменная', file: 'файл',
    periph: 'периферия (регистры)',
  };

  // PAGE_EXTRA_NODES holds page-local synthetic nodes (e.g. level 0's
  // variable barrels, bnd_0/bnd_1/...) that aren't real entities and so were
  // never worth putting in the shared graph-data.js — same idea as
  // CFG_LINKS below, just for tooltip info instead of a href.
  function nodes() {
    return { ...(window.GRAPH && window.GRAPH.nodes), ...window.PAGE_EXTRA_NODES };
  }

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

  // also escapes '>' (not just '&'/'<'): needed wherever this feeds a
  // graphviz HTML-like label=<...> block (setupRelationsDiagram) — a raw
  // '->' in a function's doc-comment description (common in this codebase)
  // otherwise corrupts the label's own delimiters and silently breaks that
  // render. Matches index.mjs's server-side dotEsc, which already does this.
  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  // Which side of the cursor the tip grows toward: *behind* the direction
  // the cursor is travelling in — trailing where it came from rather than
  // sitting ahead of it, which otherwise put the tip directly in the way of
  // continued movement in that direction. lastMouseX/Y and tipDirX/Y persist
  // across calls (module-level, not per-diagram) so direction survives
  // between events; TIP_DIR_THRESHOLD keeps a stray pixel of hand tremor
  // between two mousemove events from flipping the side back and forth —
  // direction only updates once actual travel since the last call clears
  // that threshold, otherwise it keeps the last known direction (sticky
  // through a momentary pause, and a sane default of down-right/tip-up-left
  // before any movement has ever been recorded this page load).
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
    // still clamp inside the viewport — the travel direction can still land
    // the tip off-screen near the window's own edge
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  // hoisted out of setupGraphvizSvg so setupRelationsDiagram (a different
  // node/edge wiring for the same tooltip) can share it instead of
  // duplicating the info-lookup + render logic
  function hideTip() { tip.style.display = 'none'; }
  function showTip(key, ev) {
    const info = nodes()[key];
    if (!info) { hideTip(); return; }
    tip.innerHTML = tipHtml(info);
    tip.style.display = 'block';
    moveTip(ev);
  }

  // Every diagram ships as an already-laid-out graphviz SVG (built at build
  // time, not rendered in the browser), so node/edge discovery is simple:
  // our own ids are already the SVG ids, and edges carry their endpoints in
  // a <title>from-&gt;to</title>.
  function setupGraphvizSvg(svg) {
    const known = knownKeys();
    const nodeEls = new Map();
    svg.querySelectorAll('g.node[id]').forEach(el => {
      if (known.has(el.id)) nodeEls.set(el.id, [el]);
    });

    const edges = [];
    svg.querySelectorAll('g.edge').forEach(el => {
      const title = el.querySelector('title');
      const parts = title ? title.textContent.split('->') : null;
      if (parts && parts.length === 2 && known.has(parts[0]) && known.has(parts[1])) {
        edges.push({ el, from: parts[0], to: parts[1] });
      }
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
          const href = hrefFor(key);
          if (href) window.location.href = href;
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
  }

  // --- function-page "Связи": click a caller/callee to walk the call chain ---
  //
  // Unlike every other diagram, this one isn't fixed at build time: the base
  // 1-hop view (focus + its direct callers/callees, already baked into the
  // page) can be extended arbitrarily deep by clicking a node, one hop at a
  // time, independently on the caller side and the callee side. Doing that
  // against a diagram that already contains every hidden node (laid out once,
  // up front, with space reserved for all of it) would route edges around
  // holes for nodes the user never asked to see — so instead every click
  // rebuilds a dot subgraph containing only what should currently be visible
  // and re-lays it out with graphviz-wasm.js (lazy-loaded on first use),
  // giving a clean layout every time instead of a static one with gaps.
  let gvPromise = null;
  function loadGraphvizWasm() {
    if (gvPromise) return gvPromise;
    gvPromise = new Promise((resolve, reject) => {
      if (window.GraphvizWasm) { resolve(window.GraphvizWasm); return; }
      const s = document.createElement('script');
      s.src = (window.PAGE_REL || '') + 'graphviz-wasm.js';
      s.onload = () => resolve(window.GraphvizWasm);
      s.onerror = () => reject(new Error('graphviz-wasm.js failed to load'));
      document.head.appendChild(s);
    }).then(w => w.Graphviz.load());
    return gvPromise;
  }

  const relTrunc = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
  const RELKIND = { isr: 'ISR', entry: 'main', fn: 'func' };

  function relFnNodeLine(id, info, sameFile, pos = '') {
    const rows = [`<FONT POINT-SIZE="10">${escHtml(RELKIND[info.kind] || 'func')}</FONT>`,
      `<B>${escHtml(info.label)}</B>`];
    if (info.file && !sameFile) rows.push(`<FONT POINT-SIZE="9">${escHtml(info.file)}</FONT>`);
    if (info.desc) rows.push(`<FONT POINT-SIZE="9"><I>${escHtml(relTrunc(info.desc, 46))}</I></FONT>`);
    return `  ${id} [id="${id}"${pos} class="${info.kind}" shape=box label=<${rows.join('<BR/>')}>];`;
  }
  function relVarNodeLine(id, info, sameFile, pos = '') {
    const kindLabel = info.kind === 'extvar' ? 'ext var' : info.kind === 'gvolatile' ? 'volatile' : 'var';
    const cls = info.kind === 'extvar' ? 'ghost' : 'gvar';
    const nameColor = info.kind === 'gvolatile' ? ' COLOR="#dc2626"' : '';
    const rows = [`<FONT POINT-SIZE="10">${escHtml(kindLabel)}</FONT>`, `<B${nameColor}>${escHtml(info.label)}</B>`];
    const sub = [];
    if (info.type) sub.push(escHtml(info.type));
    if (info.static) sub.push('static');
    if (info.file && !sameFile) sub.push(escHtml(info.file));
    if (sub.length) rows.push(`<FONT POINT-SIZE="9">${sub.join(' &#183; ')}</FONT>`);
    return `  ${id} [id="${id}"${pos} class="${cls}" shape=cylinder label=<${rows.join('<BR/>')}>];`;
  }
  // peripheral block on a function's "Связи" diagram — kept compact (just the
  // name); the specific registers/bits this function touches go on the edge
  // instead (see relPeriphDirDetail), mirroring the build-time
  // dotPeriphRelNode + periphDirDetail split so a client re-layout looks
  // identical.
  function relPeriphNodeLine(id, name, pos = '') {
    const rows = [`<FONT POINT-SIZE="10">периферия</FONT>`, `<B>${escHtml(name)}</B>`];
    return `  ${id} [id="${id}"${pos} class="periph" shape=hexagon label=<${rows.join('<BR/>')}>];`;
  }
  // mirrors index.mjs's isEnableFlagName/shortFlagName exactly (see there for
  // the rationale) — two separate runtimes (this file ships to the browser,
  // index.mjs runs at build time), so the logic is duplicated rather than
  // shared.
  const ENABLE_FLAG_RE = /(?:EN|ON|UE)$/;
  function isEnableFlagName(name) { return ENABLE_FLAG_RE.test(name); }
  // drops only the leading family segment (`DMA_CCR_EN` -> `CCR_EN`), keeps
  // the register — same rule for every peripheral, no RCC special case.
  function shortFlagName(flagName) {
    const idx = flagName.indexOf('_');
    return idx === -1 ? flagName : flagName.slice(idx + 1);
  }
  // one direction's full register/bit breakdown — mirrors index.mjs's
  // periphDirDetail. No longer the edge's *visible* label (see addPeriphOf):
  // a long version of it used to be baked straight into the graphviz label,
  // and neato has no box to fit a tall multi-line label against, so it would
  // drift the label away from the edge once a function touched enough
  // registers at once. Returned separately and revealed only on hover — see
  // injectPeriphDetailLabels and the .periph-detail/.periph-default CSS pair.
  function relPeriphDirDetail(regs, dir, cap = 6) {
    const relevant = regs.filter(r => r.mode.includes(dir));
    if (!relevant.length) return { detail: '', hasEnable: false, enableLabel: '' };
    let hasEnable = false, enableLabel = '';
    const sorted = [...relevant].sort((a, b) => a.reg.localeCompare(b.reg));
    const names = sorted.map(r => {
      if (dir === 'w') {
        // r.wFlags is [name, 'set'|'clear'|'both'][] (index.mjs's periphFlags
        // 'w' side is a Map now, keyed by set/clear polarity — see
        // mergeFlagPolarity there) — mirrors periphDirDetail exactly: a bit
        // only ever cleared here gets a ~ prefix and never counts as the
        // edge's enable-default-label candidate.
        const flags = r.wFlags;
        if (!flags || !flags.length) return r.reg;
        const sortedFlags = [...flags].sort((a, b) => a[0].localeCompare(b[0]));
        if (!hasEnable) {
          const enableBit = sortedFlags.find(([fl, pol]) => isEnableFlagName(fl) && pol !== 'clear');
          if (enableBit) { hasEnable = true; enableLabel = shortFlagName(enableBit[0]); }
        }
        return sortedFlags.map(([fl, pol]) => (pol === 'clear' ? '~' : '') + shortFlagName(fl)).join(', ');
      }
      const flags = r.rFlags;
      if (flags && flags.length) {
        const sortedFlags = [...flags].sort();
        return sortedFlags.map(shortFlagName).join(', ');
      }
      return r.reg;
    });
    const shown = names.slice(0, cap);
    if (names.length > cap) shown.push(`+${names.length - cap}`);
    return { detail: shown.join('\\n'), hasEnable, enableLabel };
  }
  // Two edges between the exact same pair of nodes but opposite direction (a
  // write-direction access edge and its read-direction sibling) otherwise
  // draw as one perfectly straight, perfectly coincident line — client-side
  // DOM equivalent of index.mjs's bendAntiParallelEdges (see there for the
  // full rationale, incl. why tailport/headport was tried and reverted).
  // Bends each half of a real anti-parallel pair into a gentle bow after
  // layout, endpoints unchanged, and rotates the arrowhead to match.
  //
  // No explicit left/right sign needed: the reverse edge of a pair runs the
  // *same* physical line from the opposite end, so its own (dx,dy) — and
  // therefore its own perpendicular — already points the other way on its
  // own.
  function bendOneEdge(el, path, polygon) {
    const d = path.getAttribute('d');
    const nums = d && d.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 4) return;
    const x1 = parseFloat(nums[0]), y1 = parseFloat(nums[1]);
    const x2 = parseFloat(nums[nums.length - 2]), y2 = parseFloat(nums[nums.length - 1]);
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return; // coincident nodes — nothing sane to bend
    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    const bend = Math.min(18, len * 0.16);
    const cx = midX + (-dy / len) * bend, cy = midY + (dx / len) * bend;
    path.setAttribute('d', `M${x1.toFixed(2)},${y1.toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`);
    if (polygon) {
      // a quadratic bezier's tangent at the endpoint points from the control
      // point straight to the endpoint — rotate the arrowhead to match it.
      const rot = Math.atan2(y2 - cy, x2 - cx) - Math.atan2(dy, dx);
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const pts = polygon.getAttribute('points').trim().split(/\s+/).map(p => {
        const [px, py] = p.split(',').map(Number);
        const rx = px - x2, ry = py - y2;
        return `${(x2 + rx * cos - ry * sin).toFixed(2)},${(y2 + rx * sin + ry * cos).toFixed(2)}`;
      }).join(' ');
      polygon.setAttribute('points', pts);
    }
    // the label (if any) was placed by graphviz for the *straight* line —
    // shift it by the same offset the control point moved off the
    // straight-line midpoint, or it's left stranded where the line used to
    // run instead of following the curve it's actually sitting on now.
    const offX = cx - midX, offY = cy - midY;
    el.querySelectorAll('text').forEach(t => {
      t.setAttribute('x', (parseFloat(t.getAttribute('x')) + offX).toFixed(2));
      t.setAttribute('y', (parseFloat(t.getAttribute('y')) + offY).toFixed(2));
    });
  }
  function bendAntiParallelEdges(svgRoot) {
    const edges = [];
    svgRoot.querySelectorAll('g.edge').forEach(el => {
      const title = el.querySelector('title');
      const parts = title ? title.textContent.split('->') : null;
      const path = parts && parts.length === 2 && el.querySelector('path');
      if (path) edges.push({ el, from: parts[0], to: parts[1], path });
    });
    const pairKeys = new Set(edges.map(e => `${e.from}>${e.to}`));
    for (const e of edges) {
      if (pairKeys.has(`${e.to}>${e.from}`)) bendOneEdge(e.el, e.path, e.el.querySelector('polygon'));
    }
  }

  // client-side DOM equivalent of index.mjs's injectPeriphDetailLabels
  // (string/regex there, real DOM here since this runs in the browser).
  // `details` is the {from, to, detail} list addPeriphOf collected while
  // building the edges. Revealed by the same .periph-detail/.periph-default
  // CSS pair keyed off .hl that the existing hover system already toggles —
  // no extra listeners needed for the swap itself.
  // perpendicular push, off graphviz's own on-the-line anchor point —
  // mirrors index.mjs's pushLabelPerp/pathPoints exactly (see there for the
  // full rationale): two tiers, not one flat distance — the always-visible
  // default label sits close (PUSH_NEAR), the hover-revealed detail stack
  // sits further out, growing with how many lines it has to fit (PUSH_NEAR +
  // PUSH_PER_LINE * lines). Direction comes from the path's local segment
  // nearest the label's own point, not the overall start-to-end chord — a
  // longer edge routed around other nodes can have local direction that
  // differs noticeably from its overall chord.
  const PERIPH_LABEL_PUSH_NEAR = 8;
  const PERIPH_LABEL_PUSH_PER_LINE = 6;
  function pathPoints(pathEl) {
    const d = pathEl && pathEl.getAttribute('d');
    const nums = d && d.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 4) return null;
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([parseFloat(nums[i]), parseFloat(nums[i + 1])]);
    return pts;
  }
  function pushLabelPerp(pathEl, x0, y0, dist) {
    const pts = pathPoints(pathEl);
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
  function injectPeriphDetailLabels(svgRoot, details) {
    if (!details.length) return;
    const byPair = new Map();
    svgRoot.querySelectorAll('g.edge').forEach(el => {
      const title = el.querySelector('title');
      const parts = title ? title.textContent.split('->') : null;
      if (parts && parts.length === 2) byPair.set(parts[0] + '>' + parts[1], el);
    });
    for (const { from, to, detail } of details) {
      const el = byPair.get(from + '>' + to);
      const text = el && el.querySelector('text');
      if (!text) continue;
      text.classList.add('periph-default');
      const path = el.querySelector('path');
      const origX = parseFloat(text.getAttribute('x')), origY = parseFloat(text.getAttribute('y'));
      const lines = detail.split('\\n');
      const near = pushLabelPerp(path, origX, origY, PERIPH_LABEL_PUSH_NEAR);
      const far = pushLabelPerp(path, origX, origY, PERIPH_LABEL_PUSH_NEAR + PERIPH_LABEL_PUSH_PER_LINE * lines.length);
      text.setAttribute('x', near.x.toFixed(2));
      text.setAttribute('y', near.y.toFixed(2));
      const dy = 12;
      const baseY = far.y - dy * (lines.length - 1) / 2;
      const clones = lines.map((line, i) => {
        const clone = text.cloneNode(false);
        clone.classList.remove('periph-default');
        clone.classList.add('periph-detail');
        clone.setAttribute('x', far.x.toFixed(2));
        clone.setAttribute('y', (baseY + dy * i).toFixed(2));
        clone.textContent = line;
        return clone;
      });
      text.after(...clones);
    }
  }
  const relCallEdge = (callerId, calleeId) => `  ${callerId} -> ${calleeId} [dir=forward, style=dashed];`;
  // always 0-2 separate directed lines (never dir=both) — see
  // dotPeriphAccessEdges/dotAccessEdges in index.mjs for why: a register or
  // var that's both read and written gets its own write edge and read edge,
  // each with its own label, instead of one double-headed arrow. Endpoints
  // stay at the plain node centers — see bendAntiParallelEdges for how the
  // resulting coincident write/read lines get visually told apart instead.
  // dashedRead: periph edges are solid=write/dashed=read (see
  // dotPeriphAccessEdges in index.mjs) — plain variable access edges never
  // used dashed for direction, only for call edges (relCallEdge above), so
  // this only applies when addPeriphOf asks for it.
  function relAccessEdge(fnIdStr, otherIdStr, mode, wLabel = '', rLabel = '', dashedRead = false) {
    // len: see dotEdge's comment in index.mjs — a labeled edge otherwise gets
    // no extra room reserved for the text, and a short one can spill it onto
    // a node. Only engages neato/fdp; dot ignores it.
    const lines = [];
    if (mode.includes('w')) {
      const attrs = wLabel ? ` label="${escHtml(wLabel)}", len=3.5` : '';
      lines.push(`  ${fnIdStr} -> ${otherIdStr} [dir=forward${attrs}];`);
    }
    if (mode.includes('r')) {
      const attrs = (rLabel ? ` label="${escHtml(rLabel)}", len=3.5` : '') + (dashedRead ? ', style=dashed' : '');
      lines.push(`  ${otherIdStr} -> ${fnIdStr} [dir=forward${attrs}];`);
    }
    return lines;
  }

  function setupRelationsDiagram(diagram) {
    const focusId = diagram.dataset.focus;
    const G = nodes();
    if (!focusId || !G[focusId]) return null; // no adjacency data — leave the static SVG alone

    let curEngine = diagram.dataset.curEngine;
    let showVars = true;
    let upPath = [];   // chain of caller ids, focus outward
    let downPath = []; // chain of callee ids, focus outward
    let rendering = false, pending = false;
    // Positions (inches, graphviz's own space) from the previous pinned
    // render, keyed by node id, plus that layout's total graph height (inches)
    // — both needed to hold already-visible nodes still on the next click
    // instead of letting the whole diagram reshuffle. Every id present here is
    // re-emitted next render with pos="x,y!", which nails it in place; only the
    // freshly-added frontier nodes are free to move. graphviz still shifts the
    // whole pinned cluster as one rigid block to make room for the newcomers
    // (relative positions are preserved exactly), so render() pans .inner by
    // the focus node's before/after delta to cancel that block shift out.
    // Only meaningful for neato/fdp: dot is rank-based with no notion of
    // "start from this position", so lastPos is left null (and pinning skipped)
    // there.
    let lastPos = null;
    let lastHeight = 0;

    // dot has no notion of a pinned x,y, but reordering *within* a rank
    // (dot's crossing-minimization re-deciding top-to-bottom order every
    // render) turned out to be the actual source of "everything jumps" for
    // dot — not the rank/column assignment itself, which is already stable
    // since it's ours (see rankKeyOf: derived from depthOf, not from dot's own
    // longest-path computation). lastOrder remembers, per rank, the sequence
    // nodes appeared in last render; buildDot() re-asserts that sequence via
    // an explicit `{rank=same; ...}` group plus a chain of invisible
    // (style=invis) ordering edges — the standard graphviz technique for
    // controlling in-rank order. New nodes are appended after the kept ones.
    // This is a bias, not a hard guarantee: a real call edge between two
    // rank-mates (a sibling calling a sibling) imposes its own precedence
    // that can override an arbitrary requested order — topoOrder() below
    // resolves that by never requesting an order that contradicts a real
    // edge in the first place. Measured across 15 real functions / 26 clicks:
    // 0 unresolved reorders; one deep (29-node) synthetic case needed one
    // settle-in swap that then held stable, never a repeat reshuffle.
    let lastOrder = null; // rankKey -> [ids in previous top-to-bottom order]

    // Stable order for one rank's nodes: respects every real edge between two
    // rank-mates (tail must precede head — otherwise the invisible ordering
    // edge we're about to add would directly contradict a real one, which is
    // what let dot override our request in the first place), and among nodes
    // free of such constraints, prefers preferredOrder (kept-from-last-render
    // nodes first, in their old sequence, then newly-added ones). Plain Kahn's
    // algorithm; a cycle (two rank-mates calling each other both ways) is
    // vanishingly rare for real call graphs, so on one, whatever's left just
    // gets appended rather than looping forever.
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

    // plain-format layout: node lines are "node <id> <x> <y> <w> <h> ...",
    // coords in inches, origin bottom-left; the leading "graph 1 <w> <h>" line
    // carries the whole graph's size. That's exactly the space pos="x,y!" reads
    // back, so a plain layout is the round-trip source for pinning (the SVG's
    // point coordinates would need un-flipping and margin bookkeeping first).
    function parsePlain(txt) {
      const pos = new Map();
      let height = 0;
      for (const line of txt.split('\n')) {
        const t = line.trim().split(/\s+/);
        if (t[0] === 'graph') height = parseFloat(t[3]);
        else if (t[0] === 'node') pos.set(t[1], { x: parseFloat(t[2]), y: parseFloat(t[3]) });
      }
      return { pos, height };
    }

    // Builds the dot text for "everything that should currently be visible":
    // focus, its base callers/callees, every already-chosen link in
    // upPath/downPath, and — for each of those two chains — one more level
    // (the "frontier": candidates the user hasn't picked between yet, shown
    // at full color since nothing there has been narrowed down). Variables
    // are only ever shown for focus itself — this diagram is about the call
    // *chain*, and a chain node's own reads/writes turned out to be mostly
    // noise once a couple of hops deep (they visually compete with the call
    // edges for the same "upstream/downstream" direction).
    function buildDot() {
      const nodeLines = [];
      const edgeLines = [];
      const edgeKeys = new Set(); // "from>to", so a pair already drawn (by the
      // walk below or by the cross-link pass at the end) is never duplicated
      // into a second overlapping spline
      const seenNodes = new Set();
      const fullColor = new Set([focusId]);
      const depthOf = new Map(); // id -> { side: 'up'|'down', depth }
      const focusFile = G[focusId].file;
      const edgeDetails = []; // {from, to, detail} — see injectPeriphDetailLabels

      // Re-emit a previously-laid-out node at its old spot so this render holds
      // it still; new nodes (and everything under dot, which can't be pinned)
      // get no pos and are placed freely. See lastPos above.
      const canPin = curEngine !== 'dot' && lastPos;
      function pinOf(id) {
        if (!canPin) return '';
        const p = lastPos.get(id);
        return p ? ` pos="${p.x},${p.y}!"` : '';
      }

      // dot-only bookkeeping for in-rank ordering (see lastOrder above): every
      // real call edge (candidate for a same-rank precedence constraint), and
      // — for the var/periph nodes, which have no depthOf entry since they
      // only ever attach to focus — the access mode that decides which side
      // of focus they land on (mirrors the direction relAccessEdge draws).
      const edgePairs = [];
      const varPeriphMode = new Map(); // id -> 'r' | 'w' | 'rw'

      function ensureFn(id) {
        if (seenNodes.has(id) || !G[id]) return;
        seenNodes.add(id);
        nodeLines.push(relFnNodeLine(id, G[id], G[id].file === focusFile, pinOf(id)));
      }
      function addCallEdge(from, to) {
        const ek = from + '>' + to;
        if (edgeKeys.has(ek)) return;
        edgeKeys.add(ek);
        edgeLines.push(relCallEdge(from, to));
        edgePairs.push([from, to]);
      }
      function addVarsOf(fid) {
        if (!showVars) return;
        for (const a of (G[fid].access || [])) {
          if (!seenNodes.has(a.v) && G[a.v]) {
            seenNodes.add(a.v);
            nodeLines.push(relVarNodeLine(a.v, G[a.v], G[a.v].file === focusFile, pinOf(a.v)));
          }
          edgeLines.push(...relAccessEdge(fid, a.v, a.mode));
          fullColor.add(a.v);
          varPeriphMode.set(a.v, a.mode);
        }
      }
      // peripherals are shown, like variables, only for the focus itself and
      // only while the "переменные" toggle is on — they're the same data-access
      // concern, just against a hardware register block instead of a global.
      // No longer folds in a separate "armed" fact (arming has its own honest
      // home now — a synthetic NVIC node, same as index.mjs's
      // dotPeriphAccessEdges — see there for the full rationale): this edge
      // is purely real register access, read or write.
      function addPeriphOf(fid) {
        if (!showVars) return;
        for (const pa of (G[fid].periph || [])) {
          if (!seenNodes.has(pa.id)) {
            seenNodes.add(pa.id);
            nodeLines.push(relPeriphNodeLine(pa.id, pa.name, pinOf(pa.id)));
          }
          const w = relPeriphDirDetail(pa.regs, 'w');
          const r = relPeriphDirDetail(pa.regs, 'r');
          const mode = (r.detail ? 'r' : '') + (w.detail ? 'w' : '');
          // RCC excluded from the callout (its enable bits are clock gates
          // for *other* peripherals, not a fact about RCC itself — see
          // index.mjs's dotPeriphAccessEdges for the full rationale).
          const wDefault = pa.name === 'RCC' ? '' : (w.hasEnable ? w.enableLabel : '');
          // a blank default still needs *some* label so graphviz reserves a
          // real text anchor for injectPeriphDetailLabels to clone from.
          const wLabel = w.detail ? (wDefault || ' ') : wDefault;
          const rLabel = r.detail ? ' ' : '';
          edgeLines.push(...relAccessEdge(fid, pa.id, mode, wLabel, rLabel, true));
          if (w.detail) edgeDetails.push({ from: fid, to: pa.id, detail: w.detail });
          if (r.detail) edgeDetails.push({ from: pa.id, to: fid, detail: r.detail });
          fullColor.add(pa.id);
          varPeriphMode.set(pa.id, mode);
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

      // Connect any two nodes that are *both* already on screen, even when
      // neither is on the currently-drilled path — e.g. two sibling callees
      // that happen to call each other. Without this, that relationship only
      // showed up once you separately drilled into one of them, even though
      // both ends were already visible.
      for (const id of seenNodes) {
        const info = G[id];
        if (!info || !Array.isArray(info.calls)) continue; // skip var nodes
        for (const c of info.calls) {
          if (seenNodes.has(c)) addCallEdge(id, c);
        }
      }

      // dot only: force each node's rank explicitly from depthOf/varPeriphMode
      // (never from dot's own longest-path computation, which a fresh cross-
      // link could otherwise shift a node's rank on any click) and re-assert
      // the previous in-rank order via invisible edges — see lastOrder above.
      const orderLines = [];
      if (curEngine === 'dot') {
        const rankOf = id => {
          if (id === focusId) return 0;
          const d = depthOf.get(id);
          if (d) return d.side === 'up' ? -(d.depth + 1) : (d.depth + 1);
          const m = varPeriphMode.get(id);
          return m ? (m.includes('w') ? 1 : -1) : null;
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
          const prev = (lastOrder && lastOrder.get(rk)) || [];
          const kept = prev.filter(id => idsSet.has(id));
          const fresh = ids.filter(id => !kept.includes(id));
          const order = topoOrder(ids, precedence, [...kept, ...fresh]);
          newOrder.set(rk, order);
          orderLines.push(`  { rank=same; ${order.join('; ')}; }`);
          for (let i = 0; i < order.length - 1; i++) {
            orderLines.push(`  ${order[i]} -> ${order[i + 1]} [style=invis, weight=100];`);
          }
        }
        lastOrder = newOrder;
      }

      return { dot: [...nodeLines, ...edgeLines, ...orderLines].join('\n'), fullColor, depthOf, edgeDetails };
    }

    function wireRelationsNodes(svg, depthOf) {
      const nodeEls = new Map(); // id -> [el] (single-element, but same shape as setupGraphvizSvg)
      svg.querySelectorAll('g.node[id]').forEach(el => {
        if (G[el.id]) nodeEls.set(el.id, [el]);
      });
      const edges = [];
      svg.querySelectorAll('g.edge').forEach(el => {
        const title = el.querySelector('title');
        const parts = title ? title.textContent.split('->') : null;
        if (parts && parts.length === 2 && G[parts[0]] && G[parts[1]]) edges.push({ el, from: parts[0], to: parts[1] });
      });

      // Hover-highlight a node/edge together with everything connected to it,
      // same idea as setupGraphvizSvg elsewhere on the site — but this
      // diagram's svg is *permanently* faded (render() always adds 'fade';
      // 'hl' marks the confirmed chain, not a transient hover state), so
      // clearing by wiping every '.hl' on mouseleave would erase that
      // permanent marking too. An element that's already full-color (already
      // 'hl' from the confirmed-chain marking) has no opacity left to gain
      // from that, so it gets a '.hlring' glow instead. hoverAdded remembers,
      // per element, the *exact* class hover itself added — not just "hover
      // touched this" — so clearing only ever removes what hover put on;
      // an already-'hl' element that only gained 'hlring' this way keeps its
      // permanent 'hl' once the glow comes off, instead of fading out with it.
      let locked = null;
      const hoverAdded = new Map(); // el -> 'hl' | 'hlring', whichever hover added
      function clearHoverHighlight() {
        for (const [el, cls] of hoverAdded) el.classList.remove(cls);
        hoverAdded.clear();
      }
      function mark(el) {
        if (!el || hoverAdded.has(el)) return;
        const cls = el.classList.contains('hl') ? 'hlring' : 'hl';
        el.classList.add(cls);
        hoverAdded.set(el, cls);
      }
      function markKey(key) { (nodeEls.get(key) || []).forEach(mark); }
      function highlightNode(key) {
        markKey(key);
        for (const e of edges) {
          if (e.from === key || e.to === key) {
            mark(e.el);
            markKey(e.from);
            markKey(e.to);
          }
        }
      }
      function highlightEdge(e) {
        mark(e.el);
        markKey(e.from);
        markKey(e.to);
      }

      nodeEls.forEach((els, key) => {
        for (const el of els) {
          el.addEventListener('mouseenter', ev => {
            showTip(key, ev);
            if (!locked) { clearHoverHighlight(); highlightNode(key); }
          });
          el.addEventListener('mousemove', ev => { if (tip.style.display !== 'none') moveTip(ev); });
          el.addEventListener('mouseleave', () => {
            hideTip();
            if (!locked) clearHoverHighlight();
          });
          el.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            const href = hrefFor(key);
            if (href) window.location.href = href;
          });
          const pos = depthOf.get(key);
          if (key === focusId || !pos) {
            // focus itself and every var/periph node: nothing to expand, so a
            // click just locks/unlocks the hover highlight instead, like on
            // every other diagram
            el.addEventListener('click', ev => {
              ev.stopPropagation();
              if (locked === key) { locked = null; clearHoverHighlight(); return; }
              locked = key;
              clearHoverHighlight();
              highlightNode(key);
            });
            return;
          }
          el.addEventListener('click', ev => {
            ev.stopPropagation();
            const path = pos.side === 'up' ? upPath : downPath;
            const idx = path.indexOf(key);
            if (idx !== -1 && idx === path.length - 1) {
              path.splice(idx, 1); // re-clicking the current deepest pick: collapse one level
            } else {
              path.length = pos.depth; // new pick (or an earlier ancestor): drop everything past it
              path.push(key);
            }
            render();
          });
        }
      });

      for (const e of edges) {
        const edgeKey = 'edge:' + e.from + '>' + e.to;
        e.el.addEventListener('mouseenter', () => {
          hideTip();
          if (!locked) { clearHoverHighlight(); highlightEdge(e); }
        });
        e.el.addEventListener('mouseleave', () => { if (!locked) clearHoverHighlight(); });
        e.el.addEventListener('click', ev => {
          ev.stopPropagation();
          if (locked === edgeKey) { locked = null; clearHoverHighlight(); return; }
          locked = edgeKey;
          clearHoverHighlight();
          highlightEdge(e);
        });
      }
      svg.addEventListener('click', () => { if (locked) { locked = null; clearHoverHighlight(); } });
    }

    async function render() {
      if (rendering) { pending = true; return; }
      rendering = true;
      diagram.classList.add('loading');
      try {
        const graphviz = await loadGraphvizWasm();
        const { dot, fullColor, depthOf, edgeDetails } = buildDot();
        const pinning = curEngine !== 'dot' && lastPos;
        // same split as index.mjs's renderDotAll: dot's rank/column layout
        // never overlaps by construction, but neato/fdp place nodes by
        // spring simulation alone (desired edge length only) and never check
        // actual node boxes against each other unless told to — overlap=false
        // is the post-pass that reads each node's real width/height and
        // pushes apart anything that collides; sep adds a little breathing
        // room beyond bare non-overlap, splines routes edges around nodes
        // instead of through them.
        //
        // But that post-pass (prism) is a *proximity displacement* that scales
        // the whole drawing apart non-uniformly and does NOT honor pos="!"
        // pins — measured: it drifts already-placed nodes by inches, which is
        // exactly the reshuffle pinning exists to prevent. overlap=true keeps
        // pins exact (drift ~1e-4"): the pinned cluster stays put and only the
        // new frontier nodes are placed, at the cost of the odd new node
        // overlapping. So the very first (unpinned) render still uses the
        // clean overlap=false layout; once there are pins to preserve, every
        // subsequent render switches to overlap=true to actually preserve them.
        const engineAttrs = curEngine === 'dot'
          ? 'rankdir=LR, ranksep=0.6'
          : `overlap=${pinning ? 'true' : 'false'}, splines=true, sep="+12"`;
        const dotText = ['digraph G {',
          `  graph [fontname="Segoe UI, Helvetica, sans-serif", nodesep=0.35, ${engineAttrs}];`,
          '  node [fontname="Segoe UI, Helvetica, sans-serif", style=filled, fillcolor=white];',
          '  edge [fontname="Segoe UI, Helvetica, sans-serif", fontsize=10];',
          dot, '}'].join('\n');
        const svgText = graphviz.layout(dotText, 'svg', curEngine);
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const next = document.importNode(doc.documentElement, true);
        bendAntiParallelEdges(next);
        injectPeriphDetailLabels(next, edgeDetails);
        const inner = diagram.querySelector('.inner');
        inner.querySelector('svg').replaceWith(next);
        next.classList.add('fade');

        // Pin bookkeeping (neato/fdp only). The svg above and this plain layout
        // are the same graph laid out twice, so the plain node coords match the
        // svg exactly. If the previous render pinned nodes, the pinned cluster
        // has just been shifted rigidly to fit the newcomers — pan .inner so
        // the focus node lands back where it was. Screen-x grows with
        // graphviz-x; screen-y is flipped (origin bottom-left) and also rides
        // the change in total graph height, so both terms enter dY. 72 = points
        // per inch = svg px per inch at z=1; multiply by z for the live zoom.
        if (curEngine === 'dot') {
          lastPos = null;
          lastHeight = 0;
        } else {
          const { pos: newPos, height: newHeight } = parsePlain(graphviz.layout(dotText, 'plain', curEngine));
          if (lastPos && lastPos.has(focusId) && newPos.has(focusId)) {
            const of = lastPos.get(focusId), nf = newPos.get(focusId);
            const dX = (nf.x - of.x) * 72;
            const dY = ((newHeight - lastHeight) - (nf.y - of.y)) * 72;
            const { z, tx, ty } = getTransform(inner);
            setTransform(inner, z, tx - dX * z, ty - dY * z);
          }
          lastPos = newPos;
          lastHeight = newHeight;
        }
        next.querySelectorAll('g.node[id]').forEach(el => { if (fullColor.has(el.id)) el.classList.add('hl'); });
        next.querySelectorAll('g.edge').forEach(el => {
          const title = el.querySelector('title');
          const parts = title ? title.textContent.split('->') : null;
          if (parts && parts.length === 2 && fullColor.has(parts[0]) && fullColor.has(parts[1])) {
            el.classList.add('hl');
          }
        });
        wireRelationsNodes(next, depthOf);
      } catch (e) {
        console.error('relations diagram render failed:', e);
      } finally {
        diagram.classList.remove('loading');
        rendering = false;
        if (pending) { pending = false; render(); }
      }
    }

    // the build-time SVG already *is* the upPath=[]/downPath=[] state (base
    // callers/callees, nothing dimmed) — wire it in place rather than paying
    // for a redundant wasm load + re-layout before the user has clicked
    wireRelationsNodes(diagram.querySelector('svg'), buildDot().depthOf);

    return {
      switchTo(engine) {
        if (!engine || curEngine === engine) return;
        curEngine = engine;
        diagram.dataset.curEngine = engine;
        lastPos = null; // coords from the old engine's space don't transfer
        lastHeight = 0;
        render();
      },
      setVarsVisible(show) {
        if (showVars === show) return;
        showVars = show;
        render();
      },
    };
  }

  // Every graphviz diagram ships all three engines pre-rendered at build
  // time (script.engine-data) since the graphs this tool draws are cheap
  // enough to compute all three — so switching engines in the browser is
  // just swapping which pre-built <svg> sits in .inner, no client-side
  // re-layout at all.
  function setupEngineSwitchable(diagram) {
    const script = diagram.querySelector('script.engine-data');
    if (!script) return null;
    let svgs;
    try { svgs = JSON.parse(script.textContent); } catch (e) { return null; }

    // Unchecking "переменные" used to just hide the existing var nodes in
    // place, leaving the rest of the layout exactly where graphviz put it
    // with the freed space sitting there as a hole. index.mjs instead
    // renders a *second*, fully independent layout per engine with the var
    // lines never included at all (key "<engine>_novars") — so the toggle,
    // like the engine switcher, swaps to a wholly different pre-built SVG
    // where the remaining nodes are free to spread into the space, not a
    // DOM visibility flip on the one shared SVG.
    let curEngine = diagram.dataset.curEngine;
    let showVars = true;
    // two independent checkboxes (gv-cyclic-toggle / gv-setup-toggle), not one
    // exclusive choice — both checked = the plain "all" variant, exactly one
    // checked = that variant's own inclusive reachability diagram, neither
    // checked = their overlap (see buildLevel0Diagram in index.mjs)
    let cyclicOn = true, setupOn = true;
    // "DMA-потоки" — off by default (unlike vars/cyclic/setup, which start
    // checked): the source/destination edges are extra detail most views
    // don't need, so they only appear once asked for. Independent of
    // filterSuffix()/showVars, same as those two — see the key order comment
    // below.
    let dmaOn = false;
    setupGraphvizSvg(diagram.querySelector('svg'));

    // key order matches how index.mjs's buildLevel0Diagram actually names the
    // extra variants: "<engine>", "<engine>_novars", "<engine>_cyclic",
    // "<engine>_cyclic_novars", "<engine>_setuponly", "<engine>_setuponly_novars",
    // "<engine>_overlap", "<engine>_overlap_novars", each optionally also with
    // a "_dma" segment inserted right before a trailing "_novars" (see
    // withVariantSuffix in index.mjs) — filter segment, then _dma, then novars
    function filterSuffix() {
      if (cyclicOn && setupOn) return '';
      if (cyclicOn) return '_cyclic';
      if (setupOn) return '_setuponly';
      return '_overlap';
    }
    function swap() {
      const filterBase = curEngine + filterSuffix();
      const dmaBase = filterBase + (dmaOn ? '_dma' : '');
      const key = dmaBase + (showVars ? '' : '_novars');
      // a variant with nothing to hide behind "переменные" (e.g. setup-only
      // reaches no global vars) never gets its own "_novars" render (see
      // renderDotAll's hasVars gate in index.mjs) — fall back to that same
      // filtered variant's with-vars render, not all the way to svgs[curEngine],
      // or unchecking "переменные" would silently jump back to the unfiltered
      // "all" diagram instead of just leaving this one's (empty) vars alone.
      // Same idea one level up for "DMA-потоки": a filter this variant has no
      // DMA edges at all in never gets its own "_dma" render (see
      // assembleLevel0's hasDma gate) — fall back to that filter's plain
      // render (dmaBase collapses to filterBase in the fallback chain) rather
      // than all the way to the unfiltered engine default.
      const inner = diagram.querySelector('.inner');
      const old = inner.querySelector('svg');
      const doc = new DOMParser().parseFromString(
        svgs[key] || svgs[dmaBase] || svgs[filterBase] || svgs[curEngine], 'image/svg+xml');
      const next = document.importNode(doc.documentElement, true);
      old.replaceWith(next);
      setupGraphvizSvg(next);
    }
    function switchTo(engine) {
      if (!svgs[engine] || curEngine === engine) return;
      curEngine = engine;
      diagram.dataset.curEngine = engine;
      swap();
    }
    function setVarsVisible(show) {
      if (showVars === show) return;
      showVars = show;
      swap();
    }
    function setCyclicOn(on) {
      if (cyclicOn === on) return;
      cyclicOn = on;
      swap();
    }
    function setSetupOn(on) {
      if (setupOn === on) return;
      setupOn = on;
      swap();
    }
    function setDmaOn(on) {
      if (dmaOn === on) return;
      dmaOn = on;
      swap();
    }
    return { switchTo, setVarsVisible, setCyclicOn, setSetupOn, setDmaOn };
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

  // Level 0's engine-select + vars-checkbox are baked straight into this
  // diagram's own toolbar (see diagramBlockSvg in index.mjs) rather than
  // built up in JS like buildPlacementControl above — they're a property of
  // this one diagram, not a page-wide nav setting, so there's nothing to
  // construct here, just wire the two controls already sitting in the markup.
  // A page can carry more than one graphviz diagram at once (level 0 +
  // overview + include, all on index.html) — each needs its own persisted
  // choice, keyed off data-diagram-id, not one shared setting they'd stomp
  // on each other with.
  function wireDiagramToolbar(diagram, switcher) {
    const toolbar = diagram.parentElement.querySelector('.diagram-toolbar');
    if (!toolbar) return;
    const id = diagram.dataset.diagramId || 'gv';
    const engineKey = 'cg_engine_' + id;
    const varsKey = 'cg_showvars_' + id;
    const select = toolbar.querySelector('.gv-engine-select');
    const checkbox = toolbar.querySelector('.gv-vars-toggle');
    const savedEngine = storageGet(engineKey);
    if (savedEngine && savedEngine !== select.value) {
      select.value = savedEngine;
      switcher.switchTo(savedEngine);
    }
    select.addEventListener('change', () => {
      storageSet(engineKey, select.value);
      switcher.switchTo(select.value);
    });
    if (!checkbox) return;
    const savedVars = storageGet(varsKey);
    checkbox.checked = savedVars !== '0';
    switcher.setVarsVisible(checkbox.checked);
    checkbox.addEventListener('change', () => {
      storageSet(varsKey, checkbox.checked ? '1' : '0');
      switcher.setVarsVisible(checkbox.checked);
    });

    const cyclicCheckbox = toolbar.querySelector('.gv-cyclic-toggle');
    const setupCheckbox = toolbar.querySelector('.gv-setup-toggle');
    if (!cyclicCheckbox || !setupCheckbox || !switcher.setCyclicOn) return;
    const cyclicKey = 'cg_cyclic_' + id, setupKey = 'cg_setup_' + id;
    const savedCyclic = storageGet(cyclicKey), savedSetup = storageGet(setupKey);
    if (savedCyclic !== null) cyclicCheckbox.checked = savedCyclic === '1';
    if (savedSetup !== null) setupCheckbox.checked = savedSetup === '1';
    switcher.setCyclicOn(cyclicCheckbox.checked);
    switcher.setSetupOn(setupCheckbox.checked);
    cyclicCheckbox.addEventListener('change', () => {
      storageSet(cyclicKey, cyclicCheckbox.checked ? '1' : '0');
      switcher.setCyclicOn(cyclicCheckbox.checked);
    });
    setupCheckbox.addEventListener('change', () => {
      storageSet(setupKey, setupCheckbox.checked ? '1' : '0');
      switcher.setSetupOn(setupCheckbox.checked);
    });

    const dmaCheckbox = toolbar.querySelector('.gv-dma-toggle');
    if (!dmaCheckbox || !switcher.setDmaOn) return;
    const dmaKey = 'cg_dma_' + id;
    const savedDma = storageGet(dmaKey);
    if (savedDma !== null) dmaCheckbox.checked = savedDma === '1';
    switcher.setDmaOn(dmaCheckbox.checked);
    dmaCheckbox.addEventListener('change', () => {
      storageSet(dmaKey, dmaCheckbox.checked ? '1' : '0');
      switcher.setDmaOn(dmaCheckbox.checked);
    });
  }

  // TEMPORARY: lets mode/model/seed/len be freely combined and re-laid-out
  // live via graphviz-wasm.js instead of guessing which few combos to
  // pre-bake at build time — companion to the test-raw-dot script tag and
  // test-*-select/input controls index.mjs only emits under
  // TEST_NEATO_MODES. No-ops (and is cheap to call) on every other page,
  // since it just returns when that script tag isn't present. Remove this
  // function (and its call below, and the matching HTML in index.mjs) once
  // a winning combo is picked.
  //
  // mode and model left completely unset produce results empirically
  // identical to mode=major/model=shortpath (checked by diffing crossing
  // counts) — that's neato's actual default, so the preset here reflects
  // what the pre-baked "органично" render actually used, not a guess.
  const NEATO_TEST_PRESETS = { neato: { mode: 'major', model: 'shortpath', seed: '0', len: '3.5' } };
  function wireNeatoModeTester(diagram) {
    const toolbar = diagram.parentElement.querySelector('.diagram-toolbar');
    const rawDotScript = diagram.querySelector('script.test-raw-dot');
    if (!toolbar || !rawDotScript) return;
    const rawDot = JSON.parse(rawDotScript.textContent); // { all, cyclic, setuponly, overlap: {withVars, noVars} }
    const engineSelect = toolbar.querySelector('.gv-engine-select');
    const varsCheckbox = toolbar.querySelector('.gv-vars-toggle');
    const cyclicCheckbox = toolbar.querySelector('.gv-cyclic-toggle');
    const setupCheckbox = toolbar.querySelector('.gv-setup-toggle');
    const modeSel = toolbar.querySelector('.test-mode-select');
    const modelSel = toolbar.querySelector('.test-model-select');
    const seedInput = toolbar.querySelector('.test-seed-input');
    const lenInput = toolbar.querySelector('.test-len-input');
    if (!engineSelect || !modeSel || !modelSel || !seedInput || !lenInput) return;
    const controls = [modeSel, modelSel, seedInput, lenInput];

    function applyPreset(engine) {
      const preset = NEATO_TEST_PRESETS[engine];
      controls.forEach(el => { el.disabled = !preset; });
      if (!preset) return;
      modeSel.value = preset.mode;
      modelSel.value = preset.model;
      seedInput.value = preset.seed;
      lenInput.value = preset.len;
    }

    async function renderCustom() {
      try {
        const graphviz = await loadGraphvizWasm();
        // honor all three checkboxes — otherwise every test-control change
        // re-drew the *all, with-vars* raw dot regardless of any of their
        // current states, so all of them silently reset the moment you
        // touched a slider
        const cyclicOn = !cyclicCheckbox || cyclicCheckbox.checked;
        const setupOn = !setupCheckbox || setupCheckbox.checked;
        const variantKey = cyclicOn && setupOn ? 'all' : cyclicOn ? 'cyclic' : setupOn ? 'setuponly' : 'overlap';
        const variant = rawDot[variantKey];
        const base = (!varsCheckbox || varsCheckbox.checked) ? variant.withVars : variant.noVars;
        let dotText = base.replace(/len=[\d.]+/g, `len=${lenInput.value}`);
        const extra = [`start=${seedInput.value}`];
        if (modeSel.value) extra.push(`mode=${modeSel.value}`);
        if (modelSel.value) extra.push(`model=${modelSel.value}`);
        dotText = dotText.replace(/graph \[([^\]]*)\]/, (m, inner) => `graph [${inner}, ${extra.join(', ')}]`);
        const svgText = graphviz.layout(dotText, 'svg', 'neato');
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const next = document.importNode(doc.documentElement, true);
        const inner = diagram.querySelector('.inner');
        inner.querySelector('svg').replaceWith(next);
        setupGraphvizSvg(next);
      } catch (e) {
        console.error('neato mode tester: render failed:', e);
      }
    }

    controls.forEach(el => el.addEventListener('change', renderCustom));
    // wireDiagramToolbar's own listener (attached first, so it runs first on
    // the same event) already swapped to the pre-baked vars/no-vars SVG for
    // whatever engine is active; re-running our own render after it, but
    // only while the test controls are actually live (current engine has a
    // preset), keeps a custom mode/model/seed/len combo from being silently
    // discarded by that swap
    if (varsCheckbox) {
      varsCheckbox.addEventListener('change', () => { if (!modeSel.disabled) renderCustom(); });
    }
    if (cyclicCheckbox) {
      cyclicCheckbox.addEventListener('change', () => { if (!modeSel.disabled) renderCustom(); });
    }
    if (setupCheckbox) {
      setupCheckbox.addEventListener('change', () => { if (!modeSel.disabled) renderCustom(); });
    }
    // engine dropdown swaps to a pre-baked SVG on its own (setupEngineSwitchable);
    // this only keeps the test controls' displayed values honest about what
    // that pre-baked render's parameters actually were
    engineSelect.addEventListener('change', () => applyPreset(engineSelect.value));
    applyPreset(engineSelect.value);
  }

  window.addEventListener('DOMContentLoaded', () => {
    renderTrail(updateTrail());
    document.body.appendChild(tip);
    document.querySelectorAll('.diagram').forEach(setupPanZoom);

    document.querySelectorAll('.diagram[data-engine="graphviz"]').forEach(d => {
      const s = d.dataset.focus ? setupRelationsDiagram(d) : setupEngineSwitchable(d);
      if (s) wireDiagramToolbar(d, s);
      wireNeatoModeTester(d);
    });
  });
})();

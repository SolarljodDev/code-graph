/* Runtime for generated pages (copied into the output as app.js).
   Renders mermaid diagrams with the ELK layout engine, then adds:
   - hover highlighting: a node lights up together with every edge from/to it
     and its direct neighbors, everything else fades;
   - a tooltip near the cursor fed from graph-data.js (window.GRAPH). */
(function () {
  'use strict';

  window.zoom = function (btn, factor) {
    const inner = btn.closest('.diagram').querySelector('.inner');
    const cur = parseFloat(inner.dataset.z || '1') * factor;
    inner.dataset.z = cur;
    inner.style.transform = 'scale(' + cur + ')';
  };

  const KIND_LABEL = {
    fn: 'функция', entry: 'точка входа', isr: 'обработчик прерывания',
    gvar: 'глобальная переменная', gvolatile: 'volatile-глобальная',
    extfn: 'внешняя функция / макрос', extvar: 'внешняя переменная', file: 'файл',
  };

  function nodes() { return (window.GRAPH && window.GRAPH.nodes) || {}; }

  // mermaid v11 node ids look like: mermaid-<ts>-flowchart-<ourId>-<n>
  function nodeKeyFromDomId(domId) {
    const G = nodes();
    if (G[domId]) return domId;
    let m = domId.match(/flowchart-(.+?)-\d+$/);
    if (m && G[m[1]]) return m[1];
    m = domId.match(/^(.+?)-\d+$/);
    if (m && G[m[1]]) return m[1];
    return null;
  }

  // mermaid v11 edge paths carry data-id="L_<from>_<to>_<n>"; older versions
  // used LS-/LE- classes. Both endpoint ids may contain underscores, so the
  // L_ form is resolved against the known node-id list.
  function edgeEndpoints(el) {
    let from = null, to = null;
    for (const c of el.classList) {
      if (c.indexOf('LS-') === 0) from = c.slice(3);
      if (c.indexOf('LE-') === 0) to = c.slice(3);
    }
    if (from && to) return [from, to];
    const G = nodes();
    const raw = (el.dataset && el.dataset.id) || el.id || '';
    const id = raw.replace(/^mermaid-\d+-/, '');
    if (id.indexOf('L_') === 0) {
      const body = id.slice(2).replace(/_\d+$/, '');
      for (const a of Object.keys(G)) {
        if (body.indexOf(a + '_') === 0) {
          const b = body.slice(a.length + 1);
          if (G[b]) return [a, b];
        }
      }
    }
    return null;
  }

  const tip = document.createElement('div');
  tip.className = 'tip';

  function tipHtml(info) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let h = '<div class="k">' + (KIND_LABEL[info.kind] || info.kind) + (info.file ? ' · ' + esc(info.file) : '') + '</div>';
    h += '<b>' + esc(info.label) + '</b>';
    if (info.sig) h += '<div class="sig">' + esc(info.sig) + '</div>';
    if (info.type) {
      h += '<div class="sig">' + esc(info.type) +
        (info.static ? ' · static' : '') + (info.volatile ? ' · volatile' : '') + '</div>';
    }
    if (info.desc) h += '<div class="d">' + esc(info.desc) + '</div>';
    if (info.writers && info.writers.length) h += '<div class="k">пишут: ' + esc(info.writers.join(', ')) + '</div>';
    if (info.readers && info.readers.length) h += '<div class="k">читают: ' + esc(info.readers.join(', ')) + '</div>';
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

  function setupSvg(svg) {
    const G = nodes();
    const nodeEls = new Map(); // graph key -> [dom elements]
    svg.querySelectorAll('g.node[id]').forEach(el => {
      const key = nodeKeyFromDomId(el.id);
      if (!key) return;
      if (!nodeEls.has(key)) nodeEls.set(key, []);
      nodeEls.get(key).push(el);
    });

    const paths = Array.from(svg.querySelectorAll('.edgePaths path, path.flowchart-link'));
    const labels = Array.from(svg.querySelectorAll('.edgeLabels .edgeLabel'));
    const pairLabels = labels.length === paths.length;
    const edges = [];
    paths.forEach((el, i) => {
      const ep = edgeEndpoints(el);
      if (ep) edges.push({ el, labelEl: pairLabels ? labels[i] : null, from: ep[0], to: ep[1] });
    });

    function clear() {
      svg.classList.remove('fade');
      svg.querySelectorAll('.hl').forEach(el => el.classList.remove('hl'));
      tip.style.display = 'none';
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

    for (const [key, els] of nodeEls) {
      for (const el of els) {
        el.addEventListener('mouseenter', ev => {
          clear();
          highlightNode(key);
          const info = G[key];
          if (info) {
            tip.innerHTML = tipHtml(info);
            tip.style.display = 'block';
            moveTip(ev);
          }
        });
        el.addEventListener('mousemove', ev => {
          if (tip.style.display !== 'none') moveTip(ev);
        });
        el.addEventListener('mouseleave', clear);
      }
    }
    for (const e of edges) {
      e.el.addEventListener('mouseenter', () => {
        clear();
        svg.classList.add('fade');
        e.el.classList.add('hl');
        if (e.labelEl) e.labelEl.classList.add('hl');
        [e.from, e.to].forEach(k => (nodeEls.get(k) || []).forEach(el => el.classList.add('hl')));
      });
      e.el.addEventListener('mouseleave', clear);
    }
  }

  window.addEventListener('DOMContentLoaded', async () => {
    document.body.appendChild(tip);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      layout: 'elk',
      elk: { nodePlacementStrategy: 'BRANDES_KOEPF' },
      flowchart: { useMaxWidth: false, htmlLabels: true },
      maxTextSize: 2000000,
      maxEdges: 5000,
    });
    try {
      await mermaid.run({ querySelector: '.mermaid' });
    } catch (e) {
      console.error('mermaid render:', e);
    }
    document.querySelectorAll('.diagram svg').forEach(setupSvg);
  });
})();

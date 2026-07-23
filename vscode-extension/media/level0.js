// Webview client for the "Уровень 0" panel — entry points, peripherals, and
// the global variables exchanged between them. Renders the pre-built SVG
// variants the extension host sends (see extension.js's scanWorkspaceLevel0 /
// src/level0-analyzer.mjs), and wires the vars/cyclic/setup/dma checkboxes to
// an instant SVG swap (no client-side re-layout — same idea as viewer.js's
// setupEngineSwitchable, minus the engine dimension: only `neato` is ported).
(function () {
  const vscode = acquireVsCodeApi();
  const status = document.getElementById('status');
  const viewport = document.getElementById('viewport');
  const legendWrap = document.getElementById('legend-wrap');
  const diagram = document.getElementById('diagram');
  const inner = diagram.querySelector('.inner');
  const varsCheckbox = document.getElementById('vars-toggle');
  const cyclicCheckbox = document.getElementById('cyclic-toggle');
  const setupCheckbox = document.getElementById('setup-toggle');
  const dmaCheckbox = document.getElementById('dma-toggle');
  const refreshBtn = document.getElementById('refresh-btn');
  const maxBtn = document.getElementById('max-btn');
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomOutBtn = document.getElementById('zoom-out');

  let nodeInfo = {};
  let svgs = {};
  let showVars = true;
  let cyclicOn = true;
  let setupOn = true;
  // "DMA-потоки" — off by default (unlike vars/cyclic/setup): the
  // source/destination edges are extra detail most views don't need.
  let dmaOn = false;
  // Handle returned by hover.setupGraphvizSvg for whichever <svg> is
  // currently shown — reassigned on every swap() since toggling a checkbox
  // replaces the element (and its closure-held highlight state) wholesale.
  let svgApi = null;
  // Name from the last symbolSelect/symbolClear message (extension.js, on
  // text-editor selection) — reapplied after swap() so toggling a checkbox
  // doesn't drop the current code-selection shading.
  let lastSymbolName = null;

  const hover = GraphView.createHoverSystem({
    nodeInfoFor: (id) => nodeInfo[id],
    onNavigate: (id, info) => {
      if (!info || typeof info.startLine !== 'number' || !info.filePath) return;
      vscode.postMessage({ type: 'navigateFn', file: info.filePath, startLine: info.startLine });
    },
  });

  function showStatus(text, isError) {
    viewport.classList.remove('ready');
    status.style.display = 'block';
    status.textContent = text;
    status.classList.toggle('error', !!isError);
  }

  // key order matches level0-analyzer.mjs's buildLevel0Diagram: "neato",
  // "neato_novars", "neato_cyclic", "neato_cyclic_novars",
  // "neato_setuponly", "neato_setuponly_novars", "neato_overlap",
  // "neato_overlap_novars" -- filter segment always comes before novars.
  function filterSuffix() {
    if (cyclicOn && setupOn) return '';
    if (cyclicOn) return '_cyclic';
    if (setupOn) return '_setuponly';
    return '_overlap';
  }
  // "DMA-потоки" (CPAR/CMAR data-flow edges plus their channel/buffer nodes,
  // tagged .dma-flow -- see level0-analyzer.mjs's assembleLevel0 /
  // resolveDmaRef) is baked directly into the cyclic/setup-only renders now,
  // not a separate re-laid-out graph -- the checkbox just masks/unmasks
  // those elements in place (level0.css), no swap() needed (user request
  // 2026-07-20). Only the cyclic/setup-only variants carry any .dma-flow
  // elements at all -- toggling while viewing the default "all" or overlap
  // combination is a harmless no-op, same as toggling "переменные" on a
  // variant that happens to have none.
  function applyDmaMask(svg) {
    if (svg) svg.classList.toggle('dma-hidden', !dmaOn);
  }
  function swap() {
    const base = 'neato' + filterSuffix();
    const key = base + (showVars ? '' : '_novars');
    // a variant with nothing to hide behind "переменные" never gets its own
    // "_novars" render (renderDotAll's hasVars gate) — fall back to that
    // same filtered variant's with-vars render.
    const svgText = svgs[key] || svgs[base] || svgs.neato;
    if (!svgText) return;
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const next = document.importNode(doc.documentElement, true);
    const old = inner.querySelector('svg');
    if (old) old.replaceWith(next); else inner.appendChild(next);
    svgApi = hover.setupGraphvizSvg(next);
    applyDmaMask(next);
    if (lastSymbolName) applySymbolSelect(lastSymbolName);
  }

  // Selecting a variable/function name in the editor (extension.js) pins the
  // matching node exactly as a manual click would — same fade/hl styling,
  // same "click empty background to release" escape hatch. Matched by
  // nodeInfo's label (the human-readable name), not by node id: ids are an
  // internal hash/kind scheme (fnId/varId/periphId) the webview has no
  // reason to know, while label is exactly the identifier text VS Code
  // reports as selected.
  function applySymbolSelect(name) {
    lastSymbolName = name;
    if (!svgApi) return;
    if (!name) { svgApi.clearExternal(); return; }
    let key = null;
    for (const k in nodeInfo) { if (nodeInfo[k].label === name) { key = k; break; } }
    if (!key) { svgApi.clearExternal(); return; }
    svgApi.selectExternal(key);
  }

  function render(msg) {
    nodeInfo = msg.nodeInfo || {};
    svgs = msg.svgs || {};
    showVars = true;
    cyclicOn = true;
    setupOn = true;
    dmaOn = false;

    varsCheckbox.checked = true;
    cyclicCheckbox.checked = true;
    setupCheckbox.checked = true;
    dmaCheckbox.checked = false;
    varsCheckbox.closest('.gv-ctrl').style.display = msg.varsToggle ? '' : 'none';
    cyclicCheckbox.closest('.gv-ctrl').style.display = msg.cyclicToggle ? '' : 'none';
    setupCheckbox.closest('.gv-ctrl').style.display = msg.cyclicToggle ? '' : 'none';
    dmaCheckbox.closest('.gv-ctrl').style.display = msg.dmaToggle ? '' : 'none';

    const savedVars = GraphView.storageGet('cg_level0_vars');
    const savedCyclic = GraphView.storageGet('cg_level0_cyclic');
    const savedSetup = GraphView.storageGet('cg_level0_setup');
    const savedDma = GraphView.storageGet('cg_level0_dma');
    if (savedVars !== null) { showVars = savedVars === '1'; varsCheckbox.checked = showVars; }
    if (savedCyclic !== null) { cyclicOn = savedCyclic === '1'; cyclicCheckbox.checked = cyclicOn; }
    if (savedSetup !== null) { setupOn = savedSetup === '1'; setupCheckbox.checked = setupOn; }
    if (savedDma !== null) { dmaOn = savedDma === '1'; dmaCheckbox.checked = dmaOn; }

    status.style.display = 'none';
    viewport.classList.add('ready');
    swap();

    if (msg.note) {
      legendWrap.querySelector('.level0-note').textContent = msg.note;
      legendWrap.querySelector('.level0-note').style.display = 'block';
    } else {
      legendWrap.querySelector('.level0-note').style.display = 'none';
    }
  }

  varsCheckbox.addEventListener('change', () => {
    showVars = varsCheckbox.checked;
    GraphView.storageSet('cg_level0_vars', showVars ? '1' : '0');
    swap();
  });
  cyclicCheckbox.addEventListener('change', () => {
    cyclicOn = cyclicCheckbox.checked;
    GraphView.storageSet('cg_level0_cyclic', cyclicOn ? '1' : '0');
    swap();
  });
  setupCheckbox.addEventListener('change', () => {
    setupOn = setupCheckbox.checked;
    GraphView.storageSet('cg_level0_setup', setupOn ? '1' : '0');
    swap();
  });
  dmaCheckbox.addEventListener('change', () => {
    dmaOn = dmaCheckbox.checked;
    GraphView.storageSet('cg_level0_dma', dmaOn ? '1' : '0');
    applyDmaMask(inner.querySelector('svg'));
  });
  refreshBtn.addEventListener('click', () => {
    showStatus('Пересканирование проекта…');
    vscode.postMessage({ type: 'refresh' });
  });
  // Final node size (and, riding the same knob, font size) — see
  // extension.js's level0NodeScale. Debounced so dragging doesn't fire a
  // full project re-scan per pixel. fontSize scales linearly off graphviz's
  // own ~14pt default, so 100% reproduces the untouched default look.
  const sizeSlider = document.getElementById('size-slider');
  const sizeValueEl = document.getElementById('size-value');
  let sizeDebounce = null;
  if (sizeSlider) {
    sizeSlider.addEventListener('input', () => {
      const pct = parseInt(sizeSlider.value, 10);
      sizeValueEl.textContent = `${pct}%`;
      clearTimeout(sizeDebounce);
      sizeDebounce = setTimeout(() => {
        showStatus('Пересканирование проекта…');
        vscode.postMessage({ type: 'setNodeSize', scale: pct / 100, fontSize: Math.round(14 * pct / 100) });
      }, 500);
    });
  }
  maxBtn.addEventListener('click', () => GraphView.toggleMaximize(diagram));
  zoomInBtn.addEventListener('click', () => {
    GraphView.applyZoom(diagram, 1.25, diagram.clientWidth / 2, diagram.clientHeight / 2);
  });
  zoomOutBtn.addEventListener('click', () => {
    GraphView.applyZoom(diagram, 0.8, diagram.clientWidth / 2, diagram.clientHeight / 2);
  });

  GraphView.setupPanZoom(diagram);
  GraphView.installKeyboardShortcuts();
  GraphView.wirePersistentDetails(document.getElementById('legend-details'), 'cg_level0_legend');

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'render') render(msg);
    else if (msg.type === 'status') showStatus(msg.text, false);
    else if (msg.type === 'error') showStatus(msg.text, true);
    else if (msg.type === 'symbolSelect') applySymbolSelect(msg.name);
    else if (msg.type === 'symbolClear') applySymbolSelect(null);
  });

  vscode.postMessage({ type: 'ready' });
})();

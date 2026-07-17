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
  // "neato_overlap_novars", each optionally also with a "_dma" segment
  // inserted right before a trailing "_novars" (see withVariantSuffix in
  // level0-analyzer.mjs) — filter segment, then _dma, then novars.
  function filterSuffix() {
    if (cyclicOn && setupOn) return '';
    if (cyclicOn) return '_cyclic';
    if (setupOn) return '_setuponly';
    return '_overlap';
  }
  function swap() {
    const filterBase = 'neato' + filterSuffix();
    const dmaBase = filterBase + (dmaOn ? '_dma' : '');
    const key = dmaBase + (showVars ? '' : '_novars');
    // a variant with nothing to hide behind "переменные" never gets its own
    // "_novars" render (renderDotAll's hasVars gate) — fall back to that
    // same filtered variant's with-vars render. Same idea one level up for
    // "DMA-потоки": a filter with no DMA edges at all never gets its own
    // "_dma" render (assembleLevel0's hasDma gate) — fall back to that
    // filter's plain render rather than all the way to the unfiltered
    // "neato" diagram.
    const svgText = svgs[key] || svgs[dmaBase] || svgs[filterBase] || svgs.neato;
    if (!svgText) return;
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const next = document.importNode(doc.documentElement, true);
    const old = inner.querySelector('svg');
    if (old) old.replaceWith(next); else inner.appendChild(next);
    hover.setupGraphvizSvg(next);
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
    swap();
  });
  refreshBtn.addEventListener('click', () => {
    showStatus('Пересканирование проекта…');
    vscode.postMessage({ type: 'refresh' });
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

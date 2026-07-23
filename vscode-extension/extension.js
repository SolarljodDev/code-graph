// Extension host (CJS entry). Deliberately one-shot, not auto-synced: earlier
// versions tried to keep the graph ribbon scrolled in lockstep with the
// editor on every scroll/selection event, which turned into a chain of race
// conditions (which function dominates the viewport, stale debounced state,
// zoom fights). Dropped in favor of two explicit actions:
//   - click a node in the graph  -> jump the editor to its source line
//   - run a command on the cursor's line -> highlight the matching node
// Both are one-shot; nothing auto-scrolls the graph while you read code.
const vscode = require('vscode');
const path = require('path');
const { pathToFileURL } = require('url');

let analyzer = null;          // lazily-imported ESM module
let panel = null;             // vscode.WebviewPanel («Алгоритмы»)
let sourceUri = null;         // document currently mirrored in the panel
let sourceFsPath = null;      // doc.uri.fsPath for sourceUri — avoids re-parsing the string form
let lastFunctions = null;     // analyzeAllFunctions() result for sourceUri
let editDebounce = null;
let cursorDecoration = null;  // vscode.TextEditorDecorationType
let selectionDebounce = null;

const EDIT_DEBOUNCE_MS = 300;
const SELECTION_DEBOUNCE_MS = 150;

async function ensureAnalyzer(context) {
  if (analyzer) return analyzer;
  const modUrl = pathToFileURL(path.join(context.extensionPath, 'src', 'cfg-analyzer.mjs')).href;
  const mod = await import(modUrl);
  await mod.initAnalyzer({ wasmDir: path.join(context.extensionPath, 'wasm') });
  analyzer = mod;
  return analyzer;
}

// --- «Уровень 0»: whole-project entry points/peripherals/vars panel --------

let level0Analyzer = null;    // lazily-imported ESM module
let level0Panel = null;       // vscode.WebviewPanel («Уровень 0»)
let level0SaveDebounce = null;

const LEVEL0_SAVE_DEBOUNCE_MS = 1500;
const LEVEL0_EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/graph-html/**,**/build/**}';

async function ensureLevel0Analyzer(context) {
  if (level0Analyzer) return level0Analyzer;
  const modUrl = pathToFileURL(path.join(context.extensionPath, 'src', 'level0-analyzer.mjs')).href;
  const mod = await import(modUrl);
  await mod.initAnalyzer({ wasmDir: path.join(context.extensionPath, 'wasm') });
  level0Analyzer = mod;
  return level0Analyzer;
}

// Result of the last successful whole-project scan (buildLevel0's return
// value — svgs/nodeInfo for «Уровень 0», plus usageByVar for «Алгоритмы»'s
// "other places this variable appears" lookup). Shared between both panels
// so a variable-selection lookup doesn't force its own separate scan when
// «Уровень 0» already has fresh data, and vice versa. Cleared on save (see
// onDidSaveTextDocument in activate()); rebuilt lazily by whichever panel
// asks for it next.
let workspaceIndexCache = null;
let workspaceIndexPromise = null;

async function buildWorkspaceIndex(context) {
  let uris;
  try {
    uris = await vscode.workspace.findFiles('**/*.{c,h}', LEVEL0_EXCLUDE_GLOB);
  } catch (e) {
    throw new Error('Не удалось найти файлы проекта: ' + e.message);
  }
  const files = [];
  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      files.push({ filePath: uri.fsPath, text: Buffer.from(bytes).toString('utf-8') });
    } catch (e) {
      // unreadable file (permissions, race with a delete) — skip it, same as
      // the analyzer's own per-file parse-failure skip.
    }
  }
  try {
    const mod = await ensureLevel0Analyzer(context);
    return await mod.buildLevel0({ files });
  } catch (e) {
    throw new Error('Ошибка анализа: ' + e.message);
  }
}

// Cache-or-build: concurrent callers (e.g. «Алгоритмы» looking up a variable
// right as «Уровень 0» opens) share the one in-flight scan instead of
// kicking off two.
function ensureWorkspaceIndex(context) {
  if (workspaceIndexCache) return Promise.resolve(workspaceIndexCache);
  if (!workspaceIndexPromise) {
    workspaceIndexPromise = buildWorkspaceIndex(context)
      .then((idx) => { workspaceIndexCache = idx; return idx; })
      .finally(() => { workspaceIndexPromise = null; });
  }
  return workspaceIndexPromise;
}

function refreshWorkspaceIndex(context) {
  workspaceIndexCache = null;
  return ensureWorkspaceIndex(context);
}

// Whole-workspace scan — deliberately not wired to onDidChangeTextDocument
// like the single-file CFG ribbon (scheduleReanalyze): reparsing every .c/.h
// file in the project on every keystroke would be far too expensive. Runs on
// panel open/refresh and (debounced) on save — see onDidSaveTextDocument in
// activate().
async function scanWorkspaceLevel0(context) {
  if (!level0Panel) return;
  level0Panel.webview.postMessage({ type: 'status', text: 'Сканирование проекта…' });
  let level0;
  try {
    level0 = await refreshWorkspaceIndex(context);
  } catch (e) {
    console.error('code-graph level0 build failed:', e);
    level0Panel.webview.postMessage({ type: 'error', text: e.message });
    return;
  }
  if (!level0) {
    level0Panel.webview.postMessage({ type: 'error', text: 'Не найдено ни main, ни обработчиков прерываний.' });
    return;
  }
  level0Panel.webview.postMessage({ type: 'render', ...level0 });
}

function getLevel0Html(webview, context) {
  const media = (f) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', f)));
  const nonce = String(Math.random()).slice(2);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${media('graph-view.css')}">
  <link rel="stylesheet" href="${media('level0.css')}">
</head>
<body>
  <div id="status">Сканирование проекта…</div>
  <div id="viewport">
    <div id="legend-wrap">
      <details class="legend-details" id="legend-details" open>
        <summary>Легенда</summary>
        <div class="legend">
          <span>точка входа <b>&mdash;</b> переменная — связь без стрелки: эти данные всегда идут в обе стороны между разными точками входа</span>
          <span>точка входа <b>&rarr;</b> периферия, <b>сплошная</b> = <b>запись</b>; периферия <b>&rarr;</b> точка входа, <b>пунктирная</b> = <b>чтение</b>; обе сразу = и то, и другое</span>
          <span><span class="chip" style="background:#e0e7ff;border-color:#4338ca"></span>&#11039; периферия (регистры вида <code>X-&gt;поле</code>)</span>
          <span>подпись вида «РЕГИСТР_EN» на сплошной стрелке — включение конкретного бита; голое «_EN» — включение только вызовом NVIC_EnableIRQ; «~ИМЯ» в подробностях по наведению — бит только выключается здесь, нигде не включается</span>
          <span>цилиндр с несколькими именами — переменные с одинаковым набором точек входа, собранные в один жгут</span>
          <span><span class="chip" style="background:#fff;border-color:#0d9488;border-style:dashed"></span>чекбокс «DMA-потоки» — показывает/прячет потоки данных DMA (CPAR/CMAR, направление по биту DIR) поверх обычных видов «цикличное»/«однократное»; снятая галка просто прячет эти стрелки и их узлы на месте, без перестроения графа</span>
          <span class="muted">наведите курсор — подсветятся связи; клик — закрепить; двойной клик по функции — перейти к коду и открыть «Алгоритмы»; клик по пустому месту — снять; колесо — зум, ЛКМ на пустом месте — перетаскивание</span>
        </div>
      </details>
      <div class="level0-note muted" style="display:none"></div>
    </div>
    <div class="diagram-wrap">
      <div class="diagram" id="diagram" tabindex="-1">
        <div class="zoombar">
          <button id="zoom-in" title="Увеличить">+</button>
          <button id="zoom-out" title="Уменьшить">&minus;</button>
        </div>
        <div class="inner"></div>
      </div>
      <div class="diagram-toolbar" id="toolbar">
        <label class="gv-ctrl"><input type="checkbox" id="vars-toggle" checked> переменные</label>
        <label class="gv-ctrl"><input type="checkbox" id="cyclic-toggle" checked> цикличное</label>
        <label class="gv-ctrl"><input type="checkbox" id="setup-toggle" checked> однократное</label>
        <label class="gv-ctrl"><input type="checkbox" id="dma-toggle"> DMA-потоки</label>
        <button id="refresh-btn" title="Обновить">&#8635;</button>
        <button class="maxbtn" id="max-btn" title="На весь экран (F)">&#9974;</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${media('graph-view.js')}"></script>
  <script nonce="${nonce}" src="${media('level0.js')}"></script>
</body>
</html>`;
}

// «Уровень 0» is a WebviewPanel beside the editor, same as «Алгоритмы» — a
// normal editor-area tab, which (unlike a bottom-panel view) the user can
// freely drag out of the window into its own floating window, split it
// differently, etc. — all native VS Code tab behavior, no extra code needed.
function openLevel0Panel(context) {
  if (level0Panel) { level0Panel.reveal(vscode.ViewColumn.Beside); return; }
  level0Panel = vscode.window.createWebviewPanel(
    'codeGraphLevel0',
    'Уровень 0',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
    }
  );
  level0Panel.webview.html = getLevel0Html(level0Panel.webview, context);
  level0Panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'ready' || msg.type === 'refresh') {
      scanWorkspaceLevel0(context);
    } else if (msg.type === 'navigateFn' && msg.file && typeof msg.startLine === 'number') {
      navigateToFunctionAndShowCfg(context, msg.file, msg.startLine);
    }
  });
  level0Panel.onDidDispose(() => { level0Panel = null; });
}

// Double-click on an entry/ISR node in «Уровень 0»: jump the editor to its
// source (possibly in a file that isn't open yet) and open/reveal
// «Алгоритмы» focused on it — reuses revealLine (for the jump+highlight) and
// locateCursorInGraph (for finding/highlighting the right CFG node), rather
// than duplicating either.
async function navigateToFunctionAndShowCfg(context, filePath, startLine) {
  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  } catch (e) {
    vscode.window.showWarningMessage(
      `Не удалось открыть ${filePath} — возможно, проект изменился с момента сканирования. ` +
      'Нажмите «Обновить» на панели «Уровень 0».'
    );
    return;
  }
  const ed = await revealLine(startLine, startLine, doc.uri.toString());
  if (!ed) return;
  openPanel(context);
  await renderAll(context, ed);
  locateCursorInGraph();
}

// --- «Связи»: interactive caller/callee chain for one function --------------
//
// A VS Code-side port of the CLI's per-function "Связи" page (index.mjs's
// graph-data.js + viewer.js's setupRelationsDiagram). Deliberately NOT a
// client-side re-layout like the web version (which loads graphviz-wasm.js
// *in the browser*): every click round-trips to the host, which rebuilds the
// dot subgraph against the cached workspace index (level0Analyzer.relations)
// and re-renders via the same Node graphviz-wasm every other diagram here
// uses — consistent with the rest of the extension, and no wasm-unsafe-eval
// CSP hole needed in the webview. Scoped down from the CLI on purpose (user
// decision 2026-07-20): dot only, no neato/fdp engine switch or position
// pinning — see renderRelations in level0-analyzer.mjs for the full
// rationale.
let relPanel = null; // vscode.WebviewPanel («Связи»)
// Interaction state for whatever function is currently focused — mirrors
// viewer.js's setupRelationsDiagram closure state, just living on the host
// instead of in the webview. lastDepthOf is the previous render's depthOf
// (id -> {side, depth}), needed to replay viewer.js's own click decision
// (collapse the deepest pick vs. drill into a new one) using only the
// clicked id the webview sends — see the 'expand' message handler below.
let relState = null; // { focusId, upPath, downPath, showVars, lastOrder, lastDepthOf } | null

function getRelHtml(webview, context) {
  const media = (f) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', f)));
  const nonce = String(Math.random()).slice(2);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${media('graph-view.css')}">
  <link rel="stylesheet" href="${media('level0.css')}">
  <link rel="stylesheet" href="${media('relations.css')}">
</head>
<body>
  <div id="status">Загрузка…</div>
  <div id="viewport">
    <div id="legend-wrap">
      <span class="muted">клик по функции — раскрыть вызовы дальше; повторный клик по последней раскрытой — свернуть; двойной клик — перейти к коду; клик по пустому месту — снять подсветку</span>
    </div>
    <div class="diagram-wrap">
      <div class="diagram" id="diagram" tabindex="-1">
        <div class="zoombar">
          <button id="zoom-in" title="Увеличить">+</button>
          <button id="zoom-out" title="Уменьшить">&minus;</button>
        </div>
        <div class="inner"></div>
      </div>
      <div class="diagram-toolbar" id="toolbar">
        <label class="gv-ctrl"><input type="checkbox" id="vars-toggle" checked> переменные</label>
        <button class="maxbtn" id="max-btn" title="На весь экран (F)">&#9974;</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${media('graph-view.js')}"></script>
  <script nonce="${nonce}" src="${media('relations.js')}"></script>
</body>
</html>`;
}

function openRelPanel(context) {
  if (relPanel) { relPanel.reveal(vscode.ViewColumn.Beside); return; }
  relPanel = vscode.window.createWebviewPanel(
    'codeGraphRelations',
    'Связи',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
    }
  );
  relPanel.webview.html = getRelHtml(relPanel.webview, context);
  relPanel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'ready') {
      if (relState) renderRelationsAndPost(context);
    } else if (msg.type === 'expand' && msg.id) {
      applyRelationsExpand(msg.id);
      renderRelationsAndPost(context);
    } else if (msg.type === 'toggleVars' && relState) {
      relState.showVars = !!msg.show;
      renderRelationsAndPost(context);
    } else if (msg.type === 'navigate' && msg.file && typeof msg.startLine === 'number') {
      // Same as «Уровень 0»'s own double-click (navigateFn below): jump to
      // the source AND surface/refresh «Алгоритмы» focused on that function
      // — the double-click's whole point is "take me to this function", and
      // that means both places it's shown, not just the editor (user request
      // 2026-07-21: equivalent to running Ctrl+Alt+G right after the jump).
      navigateToFunctionAndShowCfg(context, msg.file, msg.startLine);
    }
  });
  relPanel.onDidDispose(() => { relPanel = null; relState = null; });
}

// Replays viewer.js's own click decision — re-clicking the current deepest
// pick on a side collapses one level, anything else (a new pick, or an
// earlier ancestor on that same chain) drops everything past it and drills
// in — using lastDepthOf (this function's own previous render) instead of a
// client-side depthOf, since that state lives here now, not in the webview.
function applyRelationsExpand(id) {
  if (!relState || !relState.lastDepthOf) return;
  const pos = relState.lastDepthOf.get(id);
  if (!pos) return; // focus itself, or a var/periph node — nothing to expand
  const path = pos.side === 'up' ? relState.upPath : relState.downPath;
  const idx = path.indexOf(id);
  if (idx !== -1 && idx === path.length - 1) {
    path.splice(idx, 1);
  } else {
    path.length = pos.depth;
    path.push(id);
  }
}

async function renderRelationsAndPost(context) {
  if (!relPanel || !relState) return;
  let G;
  try {
    const idx = await ensureWorkspaceIndex(context);
    G = idx && idx.relations;
  } catch (e) {
    relPanel.webview.postMessage({ type: 'error', text: 'Ошибка анализа: ' + e.message });
    return;
  }
  if (!G || !G[relState.focusId]) {
    relPanel.webview.postMessage({ type: 'error', text: 'Функция не найдена в текущем скане проекта. Нажмите «Обновить» на «Уровне 0» (если он открыт) и попробуйте снова.' });
    return;
  }
  let result;
  try {
    const mod = await ensureLevel0Analyzer(context);
    result = await mod.renderRelations({
      G, focusId: relState.focusId, upPath: relState.upPath, downPath: relState.downPath,
      showVars: relState.showVars, prevOrder: relState.lastOrder,
    });
  } catch (e) {
    console.error('code-graph relations render failed:', e);
    relPanel.webview.postMessage({ type: 'error', text: 'Ошибка построения диаграммы: ' + e.message });
    return;
  }
  relState.lastOrder = result.newOrder;
  relState.lastDepthOf = result.depthOf;
  relPanel.webview.postMessage({
    type: 'render',
    svg: result.svg,
    fullColor: [...result.fullColor],
    depthOf: Object.fromEntries(result.depthOf),
    nodeInfo: result.nodeInfo,
    showVars: relState.showVars,
    title: G[relState.focusId].label,
  });
}

// Entry point — «Алгоритмы»'s left-click on a function's own name (main.js's
// .fn-head), not a click on a CFG node. `file` is the basename
// (path.basename) the click came from; resolveFunctionId matches it against
// the workspace-wide relations graph the same way level0-analyzer.mjs's own
// funcKey scheme does internally.
async function openRelationsFor(context, name, file) {
  openRelPanel(context);
  relPanel.webview.postMessage({ type: 'status', text: 'Загрузка…' });
  let idx, mod;
  try {
    idx = await ensureWorkspaceIndex(context);
    mod = await ensureLevel0Analyzer(context);
  } catch (e) {
    relPanel.webview.postMessage({ type: 'error', text: 'Ошибка анализа: ' + e.message });
    return;
  }
  const G = idx && idx.relations;
  const focusId = G && mod.resolveFunctionId(G, name, file);
  if (!focusId) {
    relPanel.webview.postMessage({ type: 'error', text: `Не удалось найти «${name}» в текущем скане проекта.` });
    return;
  }
  relState = { focusId, upPath: [], downPath: [], showVars: true, lastOrder: null, lastDepthOf: null };
  await renderRelationsAndPost(context);
}

function cEditor() {
  const ed = vscode.window.activeTextEditor;
  return ed && ed.document.languageId === 'c' ? ed : null;
}

// Rebuild the whole ribbon for the active document.
async function renderAll(context, editor) {
  if (!panel || !editor) return;
  const doc = editor.document;
  let res;
  try {
    const mod = await ensureAnalyzer(context);
    res = mod.analyzeAllFunctions(doc.getText());
  } catch (e) {
    console.error('code-graph analyze failed:', e);
    return;
  }
  sourceUri = doc.uri.toString();
  sourceFsPath = doc.uri.fsPath;
  lastFunctions = res.functions;
  panel.webview.postMessage({ type: 'renderAll', functions: res.functions });
  broadcastDmaVarNames(context);
}

// Tell the ribbon which variable names are DMA channel targets (CMAR/CPAR
// wiring), so it can color those tokens purple same as the periph/DMA blocks
// in «Уровень 0»/«Связи» (user request 2026-07-22). Rides on the same cached
// whole-project index those two panels already use — ensureWorkspaceIndex
// resolves instantly once it's warm, so this is cheap on every renderAll,
// not just the first one.
function broadcastDmaVarNames(context) {
  if (!panel) return;
  ensureWorkspaceIndex(context).then((idx) => {
    if (!panel) return;
    panel.webview.postMessage({ type: 'dmaVars', names: (idx && idx.dmaVarNames) || [] });
  }).catch((e) => {
    console.error('code-graph workspace index build failed:', e);
  });
}

function scheduleReanalyze(context, editor) {
  clearTimeout(editDebounce);
  editDebounce = setTimeout(() => renderAll(context, editor), EDIT_DEBOUNCE_MS);
}

// Selecting a bare identifier in a C file broadcasts it to whichever graph
// panels are open, so they can shade out everything unrelated to it — a
// variable name dims every CFG block / level-0 node that doesn't reference
// it, a function name dims everything that doesn't call it. Deliberately not
// wired through findNodeForLine/locateCursorInGraph (that's the cursor-line
// -> single-node "locate" action, a different one-shot gesture) — this is
// name-based and works across the whole ribbon/diagram at once, and the
// receiving webview decides variable-vs-function role itself from data it
// already has (see level0.js/main.js), since only it knows which reading
// applies. Only a real, non-empty selection whose text is exactly one
// identifier counts; anything else (cursor move, multi-token selection,
// string/number literal) clears instead.
function extractSelectedIdentifier(editor) {
  const sel = editor.selection;
  if (sel.isEmpty) return null;
  const text = editor.document.getText(sel);
  return /^[A-Za-z_]\w*$/.test(text) ? text : null;
}

// Guards the async "other places" lookup below: only the reply matching the
// latest request is allowed to reach the webview, so a slow scan for an
// earlier name can't clobber a newer one that resolved faster (or arrives
// from cache). Shared by both triggers (editor selection and a graph-side
// right-click — see the 'lookupOtherPlaces' message in openPanel).
let otherPlacesSeq = 0;

// Every function anywhere in the project that reads/writes this variable —
// rides on ensureWorkspaceIndex's cache rather than a caller-specific scan,
// so this only pays whole-project-scan cost once regardless of how many
// times it's asked. Deliberately NOT filtered to "other files only": a
// `static` file-scope variable (like dwin.c's s_relay) can *only* ever be
// used within its own file, so excluding the current file left the list
// empty for exactly the variables most worth looking up — the ribbon's own
// shading is easy to miss on a long file, and this list's whole point is a
// precise, clickable jump target, not "only what the shading can't already
// show" (user report 2026-07-20: right-clicking a variable used nine times
// in the same file still said "found nowhere else").
async function lookupOtherPlaces(context, name) {
  const idx = await ensureWorkspaceIndex(context);
  if (!idx) return [];
  // A name is either a variable or a function, never usefully both — try the
  // variable index first (existing behavior), and only fall back to the
  // function index (its own declaration + callers) when that comes up empty,
  // which is always the case for a right-clicked call token.
  const varPlaces = idx.usageByVar && idx.usageByVar[name];
  if (varPlaces && varPlaces.length) return varPlaces;
  return (idx.usageByFunc && idx.usageByFunc[name]) || [];
}

function broadcastSymbolSelection(context, editor) {
  if (!editor || editor.document.languageId !== 'c') return;
  const name = extractSelectedIdentifier(editor);
  const inRibbonDoc = panel && editor.document.uri.toString() === sourceUri;
  if (!name) {
    otherPlacesSeq++; // invalidates any in-flight lookup
    const msg = { type: 'symbolClear' };
    if (inRibbonDoc) panel.webview.postMessage(msg);
    if (level0Panel) level0Panel.webview.postMessage(msg);
    return;
  }
  const msg = { type: 'symbolSelect', name };
  // "Алгоритмы" mirrors exactly one document (sourceUri) — a selection in any
  // other editor doesn't correspond to anything in its ribbon.
  if (inRibbonDoc) panel.webview.postMessage(msg);
  // "Уровень 0" spans the whole project and matches purely by name, so any
  // C-file selection is relevant to it.
  if (level0Panel) level0Panel.webview.postMessage(msg);

  // The in-ribbon shading above is instant either way; this just fills in
  // the side list a beat later once the (possibly freshly-scanned) index
  // resolves, so it's not worth blocking the message above on it.
  if (inRibbonDoc) {
    const seq = ++otherPlacesSeq;
    lookupOtherPlaces(context, name).then((places) => {
      if (seq !== otherPlacesSeq || !panel) return;
      panel.webview.postMessage({ type: 'symbolOtherPlaces', name, places });
    }).catch((e) => {
      console.error('code-graph workspace index build failed:', e);
    });
  }
}

// The smallest CFG node (of the function enclosing `line`) that covers it —
// same "most specific range wins" rule the webview itself used to apply.
function findNodeForLine(line) {
  if (!lastFunctions) return null;
  const fn = lastFunctions.find((f) => line >= f.funcRange.startLine && line <= f.funcRange.endLine);
  if (!fn) return null;
  let best = null, bestSpan = Infinity;
  for (const n of fn.nodeLines) {
    if (line >= n.startLine && line <= n.endLine) {
      const span = n.endLine - n.startLine;
      if (span < bestSpan) { bestSpan = span; best = n; }
    }
  }
  return { functionStartLine: fn.funcRange.startLine, nodeId: best ? best.id : null };
}

function locateCursorInGraph() {
  const ed = cEditor();
  if (!ed || !panel) return;
  if (ed.document.uri.toString() !== sourceUri) return;
  const hit = findNodeForLine(ed.selection.active.line);
  if (!hit) return;
  panel.reveal(vscode.ViewColumn.Beside, true);
  panel.webview.postMessage({ type: 'locate', ...hit });
}

function getHtml(webview, context) {
  const media = (f) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', f)));
  const nonce = String(Math.random()).slice(2);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${media('graph-view.css')}">
  <link rel="stylesheet" href="${media('main.css')}">
</head>
<body>
  <div id="status">Откройте C-файл — появится лента алгоритмов функций.</div>
  <div id="viewport" class="diagram" tabindex="-1"><div id="inner" class="inner"></div></div>
  <div id="other-places" class="other-places" style="display:none">
    <div class="op-head">
      <span class="op-title"></span>
      <button id="op-close" title="Скрыть">&times;</button>
    </div>
    <div class="op-list"></div>
  </div>
  <script nonce="${nonce}" src="${media('graph-view.js')}"></script>
  <script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
}

function openPanel(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
  panel = vscode.window.createWebviewPanel(
    'codeGraphCfg',
    'Алгоритмы',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
    }
  );
  panel.webview.html = getHtml(panel.webview, context);
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'ready') {
      const ed = cEditor();
      if (ed) renderAll(context, ed);
    } else if (msg.type === 'navigate' && typeof msg.startLine === 'number') {
      revealLine(msg.startLine, msg.endLine);
    } else if (msg.type === 'navigateOther' && msg.filePath && typeof msg.startLine === 'number') {
      // A cross-file "other place this variable appears" entry — just jump
      // there in a normal editor tab; unlike navigateFn (level0's
      // double-click), this deliberately doesn't also open/refocus a CFG
      // panel for that function, per user request 2026-07-20.
      revealLine(msg.startLine, msg.startLine, vscode.Uri.file(msg.filePath).toString());
    } else if (msg.type === 'lookupOtherPlaces' && msg.name) {
      // Right-click on a variable token in the graph itself (main.js's
      // tokenizeNodeText) — the same lookup broadcastSymbolSelection does
      // for an editor-side selection, just triggered from the diagram
      // instead, per user request 2026-07-20.
      const seq = ++otherPlacesSeq;
      lookupOtherPlaces(context, msg.name).then((places) => {
        if (seq !== otherPlacesSeq || !panel) return;
        panel.webview.postMessage({ type: 'symbolOtherPlaces', name: msg.name, places, explicit: true });
      }).catch((e) => {
        console.error('code-graph workspace index build failed:', e);
      });
    } else if (msg.type === 'openRelations' && msg.functionName && sourceFsPath) {
      const file = path.basename(sourceFsPath);
      openRelationsFor(context, msg.functionName, file).catch((e) => {
        console.error('code-graph openRelationsFor failed:', e);
        vscode.window.showErrorMessage('Не удалось открыть «Связи»: ' + e.message);
      });
    }
  });
  panel.onDidDispose(() => { panel = null; sourceUri = null; sourceFsPath = null; lastFunctions = null; });
}

// Jump the editor to [startLine, endLine] and briefly mark it so the clicked
// node's source is easy to spot, not just where the cursor landed. Defaults
// to sourceUri (the doc mirrored in the «Алгоритмы» panel, for its own
// click-to-navigate) but accepts an explicit target — «Уровень 0» can name
// any file in the project, not just the one «Алгоритмы» currently shows.
// Returns the shown editor (or undefined if there was nothing to reveal),
// so a caller like navigateToFunctionAndShowCfg can chain off it.
function revealLine(startLine, endLine, targetUriString) {
  const uriString = targetUriString || sourceUri;
  if (!uriString) return;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriString);
  const shown = vscode.window.visibleTextEditors.find(
    (ed) => ed.document.uri.toString() === uriString
  );
  const target = new vscode.Position(startLine, 0);
  const selection = new vscode.Range(target, target);
  const opts = { selection, viewColumn: shown ? shown.viewColumn : vscode.ViewColumn.One };
  return vscode.window.showTextDocument(doc || vscode.Uri.parse(uriString), opts).then((ed) => {
    const end = typeof endLine === 'number' ? endLine : startLine;
    const range = new vscode.Range(startLine, 0, end, ed.document.lineAt(Math.min(end, ed.document.lineCount - 1)).text.length);
    ed.setDecorations(cursorDecoration, [range]);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return ed;
  });
}

function activate(context) {
  cursorDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
  });
  context.subscriptions.push(cursorDecoration);

  context.subscriptions.push(
    vscode.commands.registerCommand('codeGraphCfg.open', () => {
      openPanel(context);
      const ed = cEditor();
      if (ed) renderAll(context, ed);
    }),
    vscode.commands.registerCommand('codeGraphCfg.locate', () => locateCursorInGraph()),
    vscode.commands.registerCommand('codeGraph.level0.open', () => {
      openLevel0Panel(context);
      scanWorkspaceLevel0(context);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === 'c') renderAll(context, editor);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = cEditor();
      if (ed && e.document === ed.document) scheduleReanalyze(context, ed);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      clearTimeout(selectionDebounce);
      selectionDebounce = setTimeout(() => broadcastSymbolSelection(context, e.textEditor), SELECTION_DEBOUNCE_MS);
    }),
    // Re-scan is only worth its cost while a panel that needs it is open —
    // and debounced separately from the single-file CFG ribbon's much
    // shorter EDIT_DEBOUNCE_MS, since this reparses the whole project.
    // «Алгоритмы»-only (no «Уровень 0») still drops the stale cache so the
    // next variable-selection lookup rebuilds it lazily, without paying for
    // an eager rescan nothing's currently asking for.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!level0Panel && !panel) return;
      if (!/\.(c|h)$/i.test(doc.fileName)) return;
      clearTimeout(level0SaveDebounce);
      level0SaveDebounce = setTimeout(() => {
        if (level0Panel) scanWorkspaceLevel0(context);
        else workspaceIndexCache = null;
      }, LEVEL0_SAVE_DEBOUNCE_MS);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };

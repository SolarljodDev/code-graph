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
let lastFunctions = null;     // analyzeAllFunctions() result for sourceUri
let editDebounce = null;
let cursorDecoration = null;  // vscode.TextEditorDecorationType

const EDIT_DEBOUNCE_MS = 300;

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

// Whole-workspace scan — deliberately not wired to onDidChangeTextDocument
// like the single-file CFG ribbon (scheduleReanalyze): reparsing every .c/.h
// file in the project on every keystroke would be far too expensive. Runs on
// panel open/refresh and (debounced) on save — see onDidSaveTextDocument in
// activate().
async function scanWorkspaceLevel0(context) {
  if (!level0Panel) return;
  level0Panel.webview.postMessage({ type: 'status', text: 'Сканирование проекта…' });
  let uris;
  try {
    uris = await vscode.workspace.findFiles('**/*.{c,h}', LEVEL0_EXCLUDE_GLOB);
  } catch (e) {
    level0Panel.webview.postMessage({ type: 'error', text: 'Не удалось найти файлы проекта: ' + e.message });
    return;
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
  let level0;
  try {
    const mod = await ensureLevel0Analyzer(context);
    level0 = await mod.buildLevel0({ files });
  } catch (e) {
    console.error('code-graph level0 build failed:', e);
    level0Panel.webview.postMessage({ type: 'error', text: 'Ошибка анализа: ' + e.message });
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
      <div class="legend">
        <span>точка входа <b>&mdash;</b> переменная — связь без стрелки: эти данные всегда идут в обе стороны между разными точками входа</span>
        <span>точка входа <b>&rarr;</b> периферия, <b>сплошная</b> = <b>запись</b>; периферия <b>&rarr;</b> точка входа, <b>пунктирная</b> = <b>чтение</b>; обе сразу = и то, и другое</span>
        <span><span class="chip" style="background:#e0e7ff;border-color:#4338ca"></span>&#11039; периферия (регистры вида <code>X-&gt;поле</code>)</span>
        <span>подпись вида «РЕГИСТР_EN» на сплошной стрелке — включение конкретного бита; голое «_EN» — включение только вызовом NVIC_EnableIRQ; «~ИМЯ» в подробностях по наведению — бит только выключается здесь, нигде не включается</span>
        <span>цилиндр с несколькими именами — переменные с одинаковым набором точек входа, собранные в один жгут</span>
        <span><span class="chip" style="background:#fff;border-color:#0d9488;border-style:dashed"></span>DMA-потоки (чекбокс «DMA-потоки») — куда канал DMA пишет данные и откуда их берёт (CPAR/CMAR), направление по биту DIR</span>
        <span class="muted">наведите курсор — подсветятся связи; клик — закрепить; двойной клик по функции — перейти к коду и открыть «Алгоритмы»; клик по пустому месту — снять; колесо — зум, ЛКМ на пустом месте — перетаскивание</span>
      </div>
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
  lastFunctions = res.functions;
  panel.webview.postMessage({ type: 'renderAll', functions: res.functions });
}

function scheduleReanalyze(context, editor) {
  clearTimeout(editDebounce);
  editDebounce = setTimeout(() => renderAll(context, editor), EDIT_DEBOUNCE_MS);
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
    }
  });
  panel.onDidDispose(() => { panel = null; sourceUri = null; lastFunctions = null; });
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
    // Re-scan is only worth its cost while the panel is actually open —
    // and debounced separately from the single-file CFG ribbon's much
    // shorter EDIT_DEBOUNCE_MS, since this reparses the whole project.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!level0Panel) return;
      if (!/\.(c|h)$/i.test(doc.fileName)) return;
      clearTimeout(level0SaveDebounce);
      level0SaveDebounce = setTimeout(() => scanWorkspaceLevel0(context), LEVEL0_SAVE_DEBOUNCE_MS);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };

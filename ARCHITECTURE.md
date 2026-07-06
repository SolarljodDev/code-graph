# ARCHITECTURE.md

Внутреннее устройство репозитория — как файлы связаны и в каком порядке выполняется пайплайн.
Про фичи и семантику диаграмм смотри README.md, здесь — только "как это работает изнутри".

**Обновляй этот файл**, если правка меняет что-то из описанного ниже: порядок стадий в
`index.mjs`, состав промежуточных структур (`funcs` / `varDefs` / `peripherals` / `fileRecords`),
формат `graph-data.js`, связь source ↔ generated файлов, или сам факт разбиения на файлы.
Небольшие правки внутри одной стадии (новый паттерн парсинга, новый tier, изменение верстки
страницы) документировать здесь не нужно — это и так видно из кода.

## Пайплайн `index.mjs` (один проход, без модулей)

Файл — линейный скрипт 1898 строк, не разбитый на модули; функции выше по файлу — примитивы
(обход AST, работа со строками), ниже — стадии, которые используют накопленное состояние.
Порядок выполнения:

1. **Parse** (`walkDir`, `extractIncludes`, `extractFunctions`, `extractFileScopeVars`,
   `buildCommentIndex`/`docCommentFor`) — tree-sitter парсит каждый файл; комментарии
   индексируются отдельно и приклеиваются к соседней декларации.
2. **Analyze** (`analyzeFunction`, `buildCfg`, `classifyAccess`, `resolveVar`, `periph`,
   `isrBaseName`) — по каждой функции строится CFG и множество read/write обращений
   к глобалам; имена резолвятся в ключи через `funcKey`/`resolveVar`; макро-периферия
   (`X->field`, не резолвящаяся в реальную переменную) распознаётся отдельно от обычных globals.
   Результат копится в module-level `Map`ах: `funcs`, `varDefs`, `peripherals`, `fileRecords`.
3. **Score/tier** (`varTier`, `sizeTier`, `fnClass`, `varClass`) — на основе накопленных
   связей считается важность переменной (кол-во читателей/писателей) для визуальных tier'ов.
4. **Build diagrams** (`build*Diagram` — overview/aggregate/include/file/level0/function/cfg) —
   каждая функция берёт срез из `funcs`/`varDefs`/`peripherals` и генерирует mermaid-код;
   `groupedDiagramBlock` сворачивает то, что не влезает, в кликабельные grey-box группы.
5. **Render** — `htmlPage`/`diagramBlock` оборачивают diagram-код в HTML; в конце скрипта
   (после определения всех функций) идут три плоских блока без обёртки в function: запись
   `graph-data.js` (per-node metadata для тултипов), `index.html`, по одной странице на файл
   и на функцию в `filesDir`/`funcsDir`.

Всё состояние — module-level переменные, а не передаваемые аргументы; стадии друг за другом
читают то, что накопили предыдущие. Добавлять новую стадию — значит вставлять код в нужную
точку этой последовательности, а не создавать отдельный файл.

## Source vs generated — не путать

- `viewer.js` — **исходник** клиентского runtime (hover, pin, zoom, breadcrumbs).
  `graph-html/app.js` — это **копия** `viewer.js`, сделанная `fs.copyFileSync` в конце
  `index.mjs` при генерации примера в `graph-html/`. Править надо только `viewer.js`;
  `graph-html/app.js` перезатирается при следующей генерации и не должен расходиться с ним.
- `graph-html/` целиком — закоммиченный **пример вывода** инструмента (сгенерированный сайт),
  не исходный код. `graph-html/index.html`, `graph-html/graph-data.js`,
  `graph-html/mermaid-elk.min.js` — всё это артефакты, не редактируются руками.
- `viewer-entry.mjs` — исходник для esbuild-бандла (mermaid + ELK layout → один IIFE).
  `dist/mermaid-elk.min.js` — закэшированный результат сборки (`ensureViewerBundle` в
  `index.mjs`, строки ~1714), пересобирается только когда `viewer-entry.mjs` новее файла в `dist/`.
- `codegraph.ps1`/`codegraph.cmd` — самостоятельный drop-in лаунчер для чужих проектов:
  клонирует этот репозиторий в `%LOCALAPPDATA%\code-graph`, ставит зависимости и запускает
  `node index.mjs`. Он не импортирует ничего из этого репо напрямую — держи в уме, что правки
  в способе вызова `index.mjs` (аргументы, порядок) нужно синхронизировать вручную.

## Данные, которых нет в коде одной строкой

- `graph-data.js` — единственный мост между build-time (`index.mjs`) и runtime (`viewer.js`):
  плоский `window.GRAPH.nodes`, ключ — id ноды (`fnId`/`varId`/`periphId`/`file_<name>`),
  значение — всё нужное для тултипа. Если добавляешь новое поле для тултипа, оно должно
  появиться и здесь (в блоке "graph-data.js" в `index.mjs`), и в чтении на стороне `viewer.js`.
- Каждая HTML-страница самодостаточна: mermaid-код инлайнится в `<script>` на странице,
  `app.js`/`graph-data.js`/`mermaid-elk.min.js` — единственные общие ассеты между страницами.

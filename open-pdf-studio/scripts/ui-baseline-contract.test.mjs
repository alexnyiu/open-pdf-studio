import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(relativePath) {
  return readFile(resolve(appRoot, relativePath), 'utf8');
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('desktop PDF viewport keeps its protected container and canvas contract', async () => {
  const app = await source('js/solid/App.jsx');
  const orderedMarkers = [
    'id="pdf-container"',
    'id="canvas-wrapper"',
    'id="canvas-container"',
    'id="pdf-canvas"',
    'id="text-highlight-canvas"',
    'id="annotation-canvas"',
    'id="continuous-container"',
    '<CanvasScrollbars />',
    '<CompareView />',
  ];

  let previous = -1;
  for (const marker of orderedMarkers) {
    assert.equal(count(app, marker), 1, `${marker} must occur exactly once`);
    const position = app.indexOf(marker);
    assert.ok(position > previous, `${marker} must keep its protected relative order`);
    previous = position;
  }
});

test('legacy PDF modules still bind to the protected viewport IDs', async () => {
  const domElements = await source('js/ui/dom-elements.js');
  const bindings = [
    ['pdfContainer', 'pdf-container'],
    ['pdfCanvas', 'pdf-canvas'],
    ['textHighlightCanvas', 'text-highlight-canvas'],
    ['annotationCanvas', 'annotation-canvas'],
    ['continuousContainer', 'continuous-container'],
    ['canvasContainer', 'canvas-container'],
  ];

  for (const [binding, id] of bindings) {
    assert.match(
      domElements,
      new RegExp(`${binding}\\s*=\\s*document\\.getElementById\\('${id}'\\)`),
      `${binding} must continue resolving #${id}`,
    );
  }

  assert.match(domElements, /pdfCanvas\.getContext\('2d'\)/);
  assert.match(domElements, /textHighlightCanvas\.getContext\('2d'\)/);
  assert.match(domElements, /annotationCanvas\.getContext\('2d'\)/);
});

test('visible shell commands keep delegating to the existing behavior owners', async () => {
  const contracts = {
    'js/solid/components/TitleBar.jsx': [
      "import('../../pdf/loader.js').then(m => m.openPDFFile())",
      "import('../../pdf/saver.js').then(m => m.savePDF())",
      "import('../../pdf/saver.js').then(m => m.savePDFAs())",
      "import('../../core/undo-manager.js').then(m => m.undo())",
      "import('../../core/undo-manager.js').then(m => m.redo())",
    ],
    'js/solid/components/app-menu/AppMenu.jsx': [
      "from '../../../pdf/loader.js'",
      "from '../../../pdf/saver.js'",
      'actionAndClose(savePDF)',
      'actionAndClose(savePDFAs)',
      'actionAndClose(showPrintDialog)',
    ],
    'js/solid/components/DocumentTabs.jsx': [
      "m.switchToTab(index)",
      "m.closeTab(index)",
      "m.openPDFFile()",
      "invoke('spawn_window_with_pdf'",
    ],
    'js/solid/components/StatusBar.jsx': [
      "import('../../pdf/renderer.js')",
      'await goToPage(',
      'await setViewMode(mode)',
      'await setZoom(pct / 100)',
    ],
    'js/solid/components/ribbon/HomeTab.jsx': [
      "from '../../../tools/manager.js'",
      "from '../../../pdf/renderer.js'",
      'onClick={() => zoomIn()}',
      'onClick={() => fitPage()}',
    ],
    'js/solid/components/ribbon/ViewTab.jsx': [
      "from '../../../pdf/renderer.js'",
      "setViewMode('single')",
      "setViewMode('continuous')",
      "setViewMode('book')",
      "setViewMode('facing')",
    ],
    'js/solid/components/ribbon/OrganizeTab.jsx': [
      "from '../../../pdf/renderer.js'",
      "from '../../../core/undo-manager.js'",
      'showInsertPageDialog()',
      'showExtractPagesDialog()',
      'showMergePdfsDialog()',
    ],
    'js/solid/components/ribbon/CommentTab.jsx': [
      "from '../../../tools/manager.js'",
      "from '../../../core/undo-manager.js'",
      "setTool('highlight')",
      "setTool('textbox')",
    ],
    'js/solid/stores/propertiesStore.js': [
      'export function updateAnnotProp(key, value)',
      'recordPropertyChange(currentAnnotation)',
      'recordBulkModify(selected, originals)',
      'redraw()',
    ],
  };

  for (const [relativePath, markers] of Object.entries(contracts)) {
    const contents = await source(relativePath);
    for (const marker of markers) {
      assert.ok(contents.includes(marker), `${relativePath} must retain callback contract: ${marker}`);
    }
  }
});

test('phase 5 shell modernization preserves the stable frame and viewport boundary', async () => {
  const app = await source('js/solid/App.jsx');
  for (const marker of [
    '<TitleBar />',
    '<DocumentTabs />',
    '<LeftPanel />',
    '<PropertiesPanel />',
    '<StatusBar />',
    '<div class="content">',
  ]) {
    assert.ok(app.includes(marker), `App.jsx must retain the shell mount: ${marker}`);
  }

  const shellStyles = await source('styles/shell-modernization.css');
  for (const marker of [
    '.title-bar',
    '.document-tabs',
    '.left-panel',
    '.properties-panel-outer',
    '#placeholder',
    '.status-bar',
    '@media (max-width: 960px)',
    '@media (max-width: 820px)',
    '.tp-docked-left',
    '.sp-panel.sp-docked-right',
  ]) {
    assert.ok(shellStyles.includes(marker), `shell-modernization.css must cover ${marker}`);
  }

  const foundations = await source('styles/design-foundations.css');
  assert.match(foundations, /--ui-panel-width-left-min:\s*120px/);
  assert.match(foundations, /--ui-panel-width-left-max:\s*500px/);
  assert.match(foundations, /\[data-theme="dark"\][\s\S]*--theme-surface:\s*#2d2d2d/);
  assert.match(foundations, /\[data-theme="dark"\][\s\S]*--theme-panel-bg:\s*#2d2d2d/);
  assert.match(foundations, /\[data-theme="dark"\][\s\S]*--theme-content-bg:\s*#181818/);
  assert.match(foundations, /\[data-theme="dark"\][\s\S]*--theme-thumbnail-selected-bg:\s*#35537f/);
  assert.doesNotMatch(
    shellStyles,
    /#pdf-container|#canvas-wrapper|#canvas-container|#pdf-canvas|#text-highlight-canvas|#annotation-canvas|#continuous-container/,
    'shell presentation styles must not redefine protected PDF viewport selectors',
  );

  const resizeSetup = await source('js/ui/setup.js');
  assert.match(resizeSetup, /const LEFT_PANEL_MIN_WIDTH = 120/);
  assert.match(resizeSetup, /const LEFT_PANEL_MAX_WIDTH = 500/);
  assert.match(resizeSetup, /Math\.max\(LEFT_PANEL_MIN_WIDTH, Math\.min\(LEFT_PANEL_MAX_WIDTH/);
});

test('phase 6 ribbon modernization preserves tab, collapse, and overflow contracts', async () => {
  const ribbon = await source('js/solid/components/ribbon/Ribbon.jsx');
  for (const marker of [
    'id="file-tab"',
    "onClick={() => setActiveTab('home')}",
    "onClick={() => setActiveTab('view')}",
    "onClick={() => setActiveTab('drawing')}",
    "onClick={() => setActiveTab('comment')}",
    "onClick={() => setActiveTab('organize')}",
    "onClick={() => setActiveTab('help')}",
    'id="tab-format-btn"',
    'id="tab-arrange-btn"',
    'id="tab-image-btn"',
    'id="ribbon-collapse-toggle"',
    'savePreferences();',
    '<Show when={!ribbonCollapsed()}>',
    '<DrawingTab />',
    '<CommentTab />',
    '<HomeTab />',
    '<ViewTab />',
    '<OrganizeTab />',
    '<HelpTab />',
  ]) {
    assert.ok(ribbon.includes(marker), `Ribbon.jsx must retain presentation contract: ${marker}`);
  }

  const tabAdapter = await source('js/solid/components/ribbon/RibbonTab.jsx');
  assert.match(tabAdapter, /dataTab=\{props\.dataTab\}/, 'RibbonTab must forward data-tab through UiTab');

  const adaptive = await source('js/solid/components/ribbon/AdaptiveGroups.jsx');
  for (const marker of [
    'ribbon-groups-adaptive',
    'ribbon-overflow-btn',
    'ribbon-overflow-flyout',
    'setOverflowStart',
  ]) {
    assert.ok(adaptive.includes(marker), `AdaptiveGroups.jsx must retain overflow contract: ${marker}`);
  }

  const styles = await source('styles/ribbon-modernization.css');
  for (const marker of [
    '--ui-ribbon-accent: #286bd8',
    '--ui-ribbon-accent: #73a8ff',
    '--ui-ribbon-chrome: #242424',
    '.ribbon-tabs',
    '.ribbon-content',
    '.ribbon-group',
    '.ribbon-btn',
    '.ribbon-overflow-flyout',
    '@media (max-width: 820px)',
  ]) {
    assert.ok(styles.includes(marker), `ribbon-modernization.css must cover ${marker}`);
  }
  assert.doesNotMatch(
    styles,
    /#pdf-container|#canvas-wrapper|#canvas-container|#pdf-canvas|#text-highlight-canvas|#annotation-canvas|#continuous-container/,
    'ribbon presentation styles must not redefine protected PDF viewport selectors',
  );

  const globalStyles = await source('styles.css');
  assert.ok(globalStyles.includes("@import './styles/ribbon-modernization.css';"));
});

test('phase 7 open workflow preserves document owners and adds an accessible empty state', async () => {
  const app = await source('js/solid/App.jsx');
  assert.ok(app.includes("import EmptyState from './components/EmptyState.jsx';"));
  assert.ok(app.includes('<EmptyState />'));
  assert.ok(app.includes('id="pdf-container"'));

  const emptyState = await source('js/solid/components/EmptyState.jsx');
  for (const marker of [
    'id="placeholder"',
    'data-phase7="open-recent-empty"',
    'openPDFFile',
    'getRecentFiles',
    'openRecentFile',
    'openAppMenu',
    'class="empty-state-open"',
    'class="empty-state-recent-item"',
  ]) {
    assert.ok(emptyState.includes(marker), `EmptyState.jsx must cover ${marker}`);
  }

  const recentOpener = await source('js/pdf/recent-file-opener.js');
  for (const marker of [
    'allow_fs_scope',
    'fileExists',
    'removeRecentFile',
    'createTab',
    'loadPDF',
  ]) {
    assert.ok(recentOpener.includes(marker), `recent-file-opener.js must preserve ${marker}`);
  }

  const openPanel = await source('js/solid/components/app-menu/OpenPanel.jsx');
  assert.ok(openPanel.includes("from '../../../pdf/recent-file-opener.js'"));
  assert.match(openPanel, /async function handleOpenRecent\(file\)[\s\S]*openRecentFile\(file\)/);

  const workflowStyles = await source('styles/phase-7-open-workflow.css');
  for (const marker of [
    '#placeholder.empty-state',
    '.empty-state-open',
    '.empty-state-recent-item',
    '.open-panel-nav-item.active',
    '@media (max-width: 820px)',
  ]) {
    assert.ok(workflowStyles.includes(marker), `phase-7-open-workflow.css must cover ${marker}`);
  }
  assert.doesNotMatch(
    workflowStyles,
    /#pdf-container|#canvas-wrapper|#canvas-container|#pdf-canvas|#text-highlight-canvas|#annotation-canvas|#continuous-container/,
    'Phase 7 open-workflow styles must not redefine protected PDF viewport selectors',
  );

  const globalStyles = await source('styles.css');
  assert.ok(globalStyles.includes("@import './styles/phase-7-open-workflow.css';"));
});

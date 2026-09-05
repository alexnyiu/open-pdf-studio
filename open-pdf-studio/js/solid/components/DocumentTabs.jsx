import i18next from '../../i18n/config.js';
import { For, Show, createSignal, onCleanup } from 'solid-js';
import { state } from '../../core/state.js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { invoke } from '../../core/platform.js';
import {
  revealInFileManager,
  revealInFileManagerLabelKey,
  canRevealInFileManager,
} from '../../core/file-manager-reveal.js';
import {
  compareActive,
  compareFocused,
  focusCompareTab,
  blurCompareTab,
  exitCompare,
  compareOldPath,
  compareNewPath,
} from '../../compare/compare-store.js';
import { ocrWorkflowForDocument } from '../stores/ocrWorkflowStore.js';
import { documentTabStartsTextEditLifecycle } from '../../text/text-edit-focus-boundary.js';

// Detach threshold — how far the mouse must travel BELOW the tab bar
// during drag before we treat it as a "detach to new window" gesture.
const DETACH_VERTICAL_PX = 60;

// Cached current-window label (set once on first mount). All windows ask
// Rust for their own label so cross-window dock IPC can identify the source.
let _currentWindowLabel = null;
async function getCurrentWindowLabel() {
  if (_currentWindowLabel !== null) return _currentWindowLabel;
  try {
    _currentWindowLabel = await invoke('current_window_label');
  } catch {
    _currentWindowLabel = 'main';
  }
  return _currentWindowLabel;
}

// Right-click context menu (Chrome-style "Open in new window" etc.)
const [ctxMenu, setCtxMenu] = createSignal(null);

async function detachTabToNewWindow(index) {
  const doc = state.documents[index];
  if (!doc) return;
  const pdfPath = doc.filePath || '';
  console.log('[detach] requested for index', index, 'pdfPath:', pdfPath);
  // Untitled docs are backed by a TEMP file that this window owns and deletes
  // on close — handing it to another process would leave a dangling reference.
  // Require an explicit save first.
  if (!pdfPath || doc.isUntitled || doc._renderTemp || doc.modified) {
    alert(i18next.t('common:repair.saveBeforeDetach'));
    return;
  }
  try {
    const label = await invoke('spawn_window_with_pdf', { pdfPath });
    console.log('[detach] spawn_window_with_pdf returned label:', label);
    // Close the source tab AFTER the new window is spawned so the user
    // visually sees the tab leave the parent.
    await closeTabAndMaybeCloseWindow(index, doc.id);
  } catch (e) {
    console.error('[detach] spawn_window_with_pdf failed:', e);
    alert(i18next.t('common:repair.detachFailed', { error: e?.message || String(e) }));
  }
}

// Close a tab in the current window. If this empties out a NON-main window
// (i.e. a previously detached one) destroy the window too — the detached
// window has no reason to keep hanging around as an empty shell.
async function closeTabAndMaybeCloseWindow(index, documentId = state.documents[index]?.id) {
  const { closeTab } = await import('../../ui/chrome/tabs.js');
  const ownedIndex = state.documents.findIndex(doc => doc.id === documentId);
  if (ownedIndex >= 0) await closeTab(ownedIndex);
  const label = await getCurrentWindowLabel();
  if (label && label !== 'main' && state.documents.length === 0) {
    try {
      await invoke('close_window_by_label', { label });
    } catch (e) {
      console.warn('close_window_by_label failed:', e);
    }
  }
}

const [editingIndex, setEditingIndex] = createSignal(-1);
const [dropTargetIndex, setDropTargetIndex] = createSignal(-1);
const [draggingIndex, setDraggingIndex] = createSignal(-1);

// Mouse-based drag state (module-level so handlers can access it)
let dragState = null;

function handleTabClick(index) {
  if (editingIndex() === index) return;
  blurCompareTab(); // switching to a PDF tab leaves the compare view
  import('../../ui/chrome/tabs.js').then(m => m.switchToTab(index));
}

async function handleCloseTab(e, index) {
  e.stopPropagation();
  const hadFocus = e.currentTarget.contains(document.activeElement) || e.currentTarget.parentElement?.contains(document.activeElement);
  const { closeTab } = await import('../../ui/chrome/tabs.js');
  const closed = await closeTab(index);
  if (closed && hadFocus) queueMicrotask(() => {
    (document.querySelector('.document-tab[aria-selected="true"]') || document.querySelector('.document-tabs-add'))?.focus();
  });
}

function handleMiddleClick(e, index) {
  if (e.button === 1) {
    e.preventDefault();
    import('../../ui/chrome/tabs.js').then(m => m.closeTab(index));
  }
}

function handleAddClick() {
  import('../../pdf/loader.js').then(m => m.openPDFFile());
}

function handleDoubleClick(e, index) {
  e.stopPropagation();
  const doc = state.documents[index];
  if (!doc) return;

  if (!doc.filePath) {
    import('../../ui/chrome/tabs.js').then(m => m.renameDocument(index, ''));
    return;
  }

  setEditingIndex(index);
}

function handleRenameKeyDown(e, index) {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitRename(e.target, index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelRename();
  }
}

function commitRename(input, index) {
  const newName = input.value.trim();
  setEditingIndex(-1);
  if (!newName) return;
  import('../../ui/chrome/tabs.js').then(m => m.renameDocument(index, newName));
}

function cancelRename() {
  setEditingIndex(-1);
}

function handleInputMount(el, doc) {
  const name = doc.fileName || '';
  el.value = name.replace(/\.pdf$/i, '');
  requestAnimationFrame(() => {
    el.focus();
    el.select();
  });
}

// --- Mouse-based tab reordering ---

const DRAG_THRESHOLD = 5; // pixels before drag starts

function handleMouseDown(e, index) {
  // Only left button, not on close button or rename input
  if (e.button !== 0) return;
  if (e.target.closest('.document-tab-close') || e.target.closest('.document-tab-rename-input')) return;
  if (editingIndex() === index) return;

  dragState = {
    fromIndex: index,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
  };

  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
}

function onDocMouseMove(e) {
  if (!dragState) return;

  if (!dragState.started) {
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragState.started = true;
    setDraggingIndex(dragState.fromIndex);
    document.body.style.userSelect = 'none';
  }

  // Find which tab the mouse is over
  const tabsContainer = document.getElementById('document-tabs');
  if (!tabsContainer) return;

  const tabElements = tabsContainer.querySelectorAll('.document-tab');
  let targetIndex = -1;

  for (let i = 0; i < tabElements.length; i++) {
    const rect = tabElements[i].getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX < rect.right) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex !== -1 && targetIndex !== dragState.fromIndex) {
    setDropTargetIndex(targetIndex);
  } else {
    setDropTargetIndex(-1);
  }

  // Detach / re-dock hand-off: once the cursor leaves the tab bar vertically,
  // stop our mouse-based tracking and start a NATIVE OS file-drag of the PDF.
  // The OS drag is what lets the user drop onto ANOTHER app instance's tab bar
  // (cross-process re-dock) — browser mouse events can't cross window/process
  // boundaries, the OS drag-drop layer can. Started ONCE per drag.
  const tabBarRect = tabsContainer.getBoundingClientRect();
  const verticalOutside =
       e.clientY > tabBarRect.bottom + DETACH_VERTICAL_PX
    || e.clientY < tabBarRect.top    - DETACH_VERTICAL_PX;
  if (verticalOutside && !dragState.nativeDragStarted) {
    dragState.nativeDragStarted = true;
    const from = dragState.fromIndex;
    // Tear down mouse tracking — the OS drag loop owns the pointer now.
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.body.style.userSelect = '';
    dragState = null;
    setDraggingIndex(-1);
    setDropTargetIndex(-1);
    startNativeTabDrag(from);
  }
}

// Start a native OS file-drag of a tab's PDF. The OS handles where it lands:
//   * dropped on another OPDS instance  → that instance docks it as a tab
//     (its onDragDropEvent), and we close our tab here;
//   * dropped on empty space            → classic detach into a new window;
//   * dropped back on ourselves         → no-op (self-drop guard keeps the tab).
async function startNativeTabDrag(index) {
  const doc = state.documents[index];
  if (!doc) return;
  const pdfPath = doc.filePath || '';
  // Untitled docs live in a temp file this window owns — don't drag them to
  // other instances (the temp file would be deleted out from under them).
  if (!pdfPath || doc.isUntitled || doc._renderTemp || doc.modified) {
    alert(i18next.t('common:repair.saveBeforeDetach'));
    return;
  }
  // Mark THIS instance as the drag source so our own drop handler ignores a
  // drop that lands back on us (no duplicate tab).
  window.__OPDS_DRAGGING_OUT__ = pdfPath;
  window.__OPDS_SELF_DROP__ = false;
  try {
    const [{ startDrag }, { invoke }] = await Promise.all([
      import('@crabnebula/tauri-plugin-drag'),
      import('../../core/platform.js'),
    ]);
    const icon = await invoke('drag_icon_path').catch(() => '');
    await startDrag({ item: [pdfPath], icon }, (payload) => {
      const result = payload?.result;
      const wasSelf = !!window.__OPDS_SELF_DROP__;
      window.__OPDS_DRAGGING_OUT__ = null;
      window.__OPDS_SELF_DROP__ = false;
      if (result === 'Dropped' && !wasSelf) {
        // Accepted by another instance/app → the tab moved; remove it here.
        closeTabAndMaybeCloseWindow(index);
      } else if (result === 'Cancelled') {
        // Dropped on empty space → classic detach into its own new window.
        detachTabToNewWindow(index);
      }
      // 'Dropped' + wasSelf → dropped back on us; keep the tab as-is.
    });
  } catch (e) {
    window.__OPDS_DRAGGING_OUT__ = null;
    console.warn('native tab drag failed, falling back to detach:', e);
    detachTabToNewWindow(index);
  }
}

// Hide the context menu when clicking anywhere else / pressing Escape.
function hideCtxMenu() { setCtxMenu(null); }

function handleTabContextMenu(e, index) {
  e.preventDefault();
  e.stopPropagation();
  const doc = state.documents[index];
  if (!doc) return;
  setCtxMenu({ x: Math.min(e.clientX, window.innerWidth - 220),
    y: Math.min(e.clientY, window.innerHeight - 120), documentId: doc.id });
  queueMicrotask(() => document.querySelector('.document-tab-ctxmenu button')?.focus());
}

function onDocMouseUp(e) {
  document.removeEventListener('mousemove', onDocMouseMove);
  document.removeEventListener('mouseup', onDocMouseUp);
  document.body.style.userSelect = '';

  if (!dragState) return;

  const from = dragState.fromIndex;
  const wasStarted = dragState.started;
  dragState = null;
  setDraggingIndex(-1);

  const target = dropTargetIndex();
  setDropTargetIndex(-1);

  // NB: detach / cross-instance re-dock is no longer handled here — once the
  // cursor leaves the tab bar vertically, onDocMouseMove hands off to a native
  // OS drag (startNativeTabDrag) and tears down these listeners. So a mouseUp
  // that reaches here is always an IN-BAR reorder.
  if (!wasStarted || target === -1 || target === from) return;

  // Track which doc is active by its id
  const activeId = state.documents[state.activeDocumentIndex]?.id;

  // Reorder
  const [moved] = state.documents.splice(from, 1);
  state.documents.splice(target, 0, moved);

  // Maintain active tab
  if (activeId) {
    const newActiveIndex = state.documents.findIndex(d => d.id === activeId);
    if (newActiveIndex !== -1) {
      state.activeDocumentIndex = newActiveIndex;
    }
  }

  import('../../ui/chrome/tabs.js').then(m => m.updateTabBar());
}

export default function DocumentTabs() {
  const { t } = useTranslation('statusbar');
  const { t: tCtx } = useTranslation('context');
  const { t: tCommon } = useTranslation('common');
  const contextIndex = () => state.documents.findIndex(doc => doc.id === ctxMenu()?.documentId);
  const restoreTabFocus = () => queueMicrotask(() =>
    (document.querySelector('.document-tab[aria-selected="true"]') || document.querySelector('.document-tabs-add'))?.focus());
  const { t: tOcr } = useTranslation('ribbon');

  const baseName = (p) => ((p || '').split(/[\\/]/).pop() || '').replace(/\.pdf$/i, '');
  const compareTabTip = () => {
    const a = baseName(compareOldPath());
    const b = baseName(compareNewPath());
    return a && b ? `${a} ↔ ${b}` : t('compareTabTitle');
  };

  // Close the tab context menu on outside click / Escape.
  const onDocClick = (e) => {
    if (!ctxMenu()) return;
    if (e.target && e.target.closest && e.target.closest('.document-tab-ctxmenu')) return;
    setCtxMenu(null);
  };
  const onDocKeyDown = (e) => { if (e.key === 'Escape' && ctxMenu()) { setCtxMenu(null); restoreTabFocus(); } };
  document.addEventListener('mousedown', onDocClick, true);
  document.addEventListener('keydown', onDocKeyDown);

  onCleanup(() => {
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onDocKeyDown);
  });

  return (
    <div class="document-tabs" id="document-tabs" role="tablist" aria-label={t('openPdfFile')}
      onKeyDown={async e => {
        if (e.target.getAttribute('role') !== 'tab') return;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          const index = Number(e.target.dataset.index);
          if (!Number.isInteger(index)) return;
          const rect = e.target.getBoundingClientRect();
          handleTabContextMenu({ preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation(),
            clientX: rect.left, clientY: rect.bottom }, index);
          return;
        }
        const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
        const index = tabs.indexOf(e.target);
        let next;
        if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); return; }
        else return;
        e.preventDefault(); tabs[next]?.focus(); tabs[next]?.click();
      }}>
      <Show when={state.documents.length === 0}>
        <div class="document-tabs-empty">{t('noDocumentsOpen')}</div>
      </Show>

      <For each={state.documents}>
        {(doc, i) => (
          <div
            class={'document-tab'
              + (i() === state.activeDocumentIndex && !compareFocused() ? ' active' : '')
              + (draggingIndex() === i() ? ' dragging' : '')
              + (dropTargetIndex() === i() ? ' drop-target' : '')}
            role="tab"
            tabIndex={i() === state.activeDocumentIndex && !compareFocused() ? 0 : -1}
            aria-selected={i() === state.activeDocumentIndex && !compareFocused()}
            aria-label={doc.fileName}
            data-index={i()}
            data-text-edit-lifecycle-transition={documentTabStartsTextEditLifecycle({
              tabIndex: i(),
              activeDocumentIndex: state.activeDocumentIndex,
              compareIsFocused: compareFocused(),
            }) ? 'true' : undefined}
            onClick={() => handleTabClick(i())}
            onAuxClick={(e) => handleMiddleClick(e, i())}
            onDblClick={(e) => handleDoubleClick(e, i())}
            onMouseDown={(e) => handleMouseDown(e, i())}
            onContextMenu={(e) => handleTabContextMenu(e, i())}
          >
            <span class="document-tab-modified">{doc.modified ? '*' : ''}</span>
            <Show when={ocrWorkflowForDocument(doc.id)}>{(job) => (
              <span
                class="document-tab-ocr-badge"
                classList={{
                  'is-running': job().finishedAt === null,
                  'is-failed': job().status === 'failed',
                  'is-terminal': job().finishedAt !== null,
                }}
                title={`${tOcr('organize.ocrProgressTitle')} · ${tOcr(`organize.ocrStates.${job().status === 'running' ? job().currentPageState : job().status}`)} · ${Math.round(job().progress * 100)}%`}
                aria-label={`${tOcr('organize.ocrProgressTitle')}, ${tOcr(`organize.ocrStates.${job().status === 'running' ? job().currentPageState : job().status}`)}, ${Math.round(job().progress * 100)}%`}
              >
                {job().finishedAt === null
                  ? `${Math.round(job().progress * 100)}%`
                  : job().status === 'failed' ? '!'
                    : job().status === 'cancelled' ? '×' : '✓'}
              </span>
            )}</Show>
            <Show when={editingIndex() === i()} fallback={
              <span class="document-tab-title" title={doc.filePath || doc.fileName}>{doc.fileName}</span>
            }>
              <input
                class="document-tab-rename-input"
                ref={(el) => handleInputMount(el, doc)}
                onKeyDown={(e) => handleRenameKeyDown(e, i())}
                onBlur={() => cancelRename()}
                onClick={(e) => e.stopPropagation()}
              />
            </Show>
            <button type="button" class="document-tab-close" data-text-edit-lifecycle-transition="true"
              aria-label={t('closeTab')} title={t('closeTab')} onClick={(e) => handleCloseTab(e, i())}>&times;</button>
          </div>
        )}
      </For>

      {/* Compare session lives as its OWN tab (not a real document) so you can
          flip between your PDFs and the side-by-side comparison. */}
      <Show when={compareActive()}>
        <div
          role="tab" tabIndex={compareFocused() ? 0 : -1} aria-selected={compareFocused()}
          class={'document-tab compare-tab' + (compareFocused() ? ' active' : '')}
          data-text-edit-lifecycle-transition="true"
          title={compareTabTip()}
          onClick={() => focusCompareTab()}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); exitCompare(); } }}
        >
          <span class="document-tab-title" style="display:inline-flex; align-items:center; gap:5px;">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;">
              <rect x="3" y="4" width="7" height="16" /><rect x="14" y="4" width="7" height="16" />
            </svg>
            {t('compareTabTitle')}
          </span>
          <button type="button" class="document-tab-close" data-text-edit-lifecycle-transition="true"
            aria-label={t('closeTab')} title={t('closeTab')} onClick={(e) => { e.stopPropagation(); exitCompare(); }}>&times;</button>
        </div>
      </Show>

      <button type="button" class="document-tabs-add" aria-label={t('openPdfFile')} title={t('openPdfFile')} onClick={handleAddClick}>+</button>

      {/* Right-click context menu for tabs — Chrome-style. Rendered inline
          because there are only one-or-two items and the existing global
          context-menu store is tightly coupled to annotation operations. */}
      <Show when={ctxMenu() && contextIndex() >= 0}>
        <div
          class="document-tab-ctxmenu" role="menu" aria-label={tCommon('repair.tabActions')}
          onKeyDown={e => {
            const items = [...e.currentTarget.querySelectorAll('[role="menuitem"]')];
            const index = items.indexOf(document.activeElement);
            let next;
            if (e.key === 'ArrowDown') next = (index + 1) % items.length;
            else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = items.length - 1;
            else if (e.key === 'Tab') { hideCtxMenu(); restoreTabFocus(); e.preventDefault(); return; }
            else return;
            e.preventDefault(); e.stopPropagation(); items[next]?.focus();
          }}
          style={{
            position: 'fixed',
            top: `${ctxMenu().y}px`,
            left: `${ctxMenu().x}px`,
            background: '#fff',
            border: '1px solid #7a7a7a',
            'box-shadow': '2px 2px 6px rgba(0,0,0,0.25)',
            'z-index': 2000,
            'min-width': '200px',
            'font-size': '13px',
          }}
          onMouseLeave={hideCtxMenu}
        >
          <button type="button" role="menuitem" class="document-tab-menu-item"
            data-text-edit-lifecycle-transition="true"
            style={{ padding: '6px 14px', cursor: 'pointer' }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#cce4f7'}
            onMouseLeave={(e) => e.currentTarget.style.background = ''}
            onClick={() => { const idx = contextIndex(); hideCtxMenu(); detachTabToNewWindow(idx); }}
          >{tCommon('repair.openInNewWindow')}</button>
          {/* Alleen tonen voor documenten met een echt bestandspad — naamloze/
              nieuwe documenten leven in een temp-bestand dat je de gebruiker
              niet wilt laten zien. Label is platform-specifiek (Verkenner/
              Finder/bestandsbeheer). */}
          <Show when={canRevealInFileManager(state.documents[contextIndex()])}>
            <button type="button" role="menuitem" class="document-tab-menu-item"
              style={{ padding: '6px 14px', cursor: 'pointer', 'border-top': '1px solid #d4d4d4' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#cce4f7'}
              onMouseLeave={(e) => e.currentTarget.style.background = ''}
              onClick={() => {
                const doc = state.documents[contextIndex()];
                hideCtxMenu();
                if (doc?.filePath) revealInFileManager(doc.filePath);
              }}
            >{tCtx(revealInFileManagerLabelKey())}</button>
          </Show>
          <button type="button" role="menuitem" class="document-tab-menu-item"
            data-text-edit-lifecycle-transition="true"
            style={{ padding: '6px 14px', cursor: 'pointer', 'border-top': '1px solid #d4d4d4' }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#cce4f7'}
            onMouseLeave={(e) => e.currentTarget.style.background = ''}
            onClick={async () => {
              const documentId = ctxMenu().documentId;
              hideCtxMenu();
              const { closeTab } = await import('../../ui/chrome/tabs.js');
              const index = state.documents.findIndex(doc => doc.id === documentId);
              if (index >= 0) await closeTab(index);
              restoreTabFocus();
            }}
          >{t('closeTab')}</button>
        </div>
      </Show>
    </div>
  );
}

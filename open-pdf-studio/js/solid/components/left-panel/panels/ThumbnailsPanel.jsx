import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { pageCount, activePage, placeholderSize, pagePlaceholderSizes, selectAllPages, clearPageSelection, getSelectedPagesArray, formatPageRangeString, setContainerRef } from '../../../stores/panels/thumbnailStore.js';
import { activeTab } from '../../../stores/leftPanelStore.js';
import ThumbnailItem from '../ThumbnailItem.jsx';
import { useTranslation } from '../../../../i18n/useTranslation.js';
import { createThumbnailGeometry } from '../../../../ui/panels/thumbnail-virtualization.js';
import { getActiveDocument } from '../../../../core/state.js';
import { recordPerformancePeak } from '../../../../pdf/performance-metrics.js';

export default function ThumbnailsPanel() {
  const { t } = useTranslation('properties');

  let container;
  let frame = 0;
  const [pendingFocus, setPendingFocus] = createSignal(null);
  const [viewport, setViewport] = createSignal({ scrollTop: 0, height: 600 });
  const geometry = createMemo(() => createThumbnailGeometry(pageCount(), {
    heightForPage: (pageNum) => (pagePlaceholderSizes[String(pageNum)] || placeholderSize()).height,
  }));
  const mounted = createMemo(() => geometry().window({
    scrollTop: viewport().scrollTop,
    viewportHeight: viewport().height,
    overscanItems: 10,
    maxItems: 32,
  }));
  const updateViewport = () => {
    if (!container) return;
    setViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
    window.__mountedThumbnailCount = mounted().pages.length;
  };
  createEffect(() => {
    const count = mounted().pages.length;
    window.__mountedThumbnailCount = count;
    recordPerformancePeak('mountedThumbnails', count);
  });
  const scheduleViewportUpdate = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; updateViewport(); });
  };

  onMount(() => {
    updateViewport();
    const observer = new ResizeObserver(scheduleViewportUpdate);
    observer.observe(container);
    onCleanup(() => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    });
  });

  createEffect(() => {
    const page = activePage();
    const index = geometry();
    if (!container || !page || !index.pageCount) return;
    queueMicrotask(() => {
      const top = index.pageTop(page);
      const bottom = index.pageBottom(page);
      if (top < container.scrollTop) container.scrollTop = top;
      else if (bottom > container.scrollTop + container.clientHeight) {
        container.scrollTop = Math.max(0, bottom - container.clientHeight);
      }
      scheduleViewportUpdate();
    });
  });

  // The target may not exist until the virtual window follows activePage.
  // Keep keyboard focus owned by this navigation until the row is mounted.
  createEffect(() => {
    const request = pendingFocus();
    const pages = mounted().pages;
    const page = activePage();
    if (!request?.ready || page !== request.publishedPage || !pages.includes(request.page)) return;
    queueMicrotask(() => {
      if (pendingFocus() !== request) return;
      if (getActiveDocument()?.id !== request.documentId) { setPendingFocus(null); return; }
      const target = container?.querySelector(`.thumbnail-item[data-page="${request.page}"]`);
      if (target) { target.focus({ preventScroll: true }); setPendingFocus(null); }
    });
  });

  const handleNavigate = async (pageNum, options = {}) => {
    const request = options.focus ? { page: pageNum, documentId: getActiveDocument()?.id, ready: false } : null;
    setPendingFocus(request);
    try {
      const renderer = await import('../../../../pdf/renderer.js');
      await renderer.goToPage(pageNum, { absolute: true, ...(options.focus ? { behavior: 'auto' } : {}) });
      if (request && pendingFocus() === request) {
        // Facing navigation publishes the spread anchor; keyboard focus still
        // belongs to the requested thumbnail on either side of that spread.
        setPendingFocus({ ...request, publishedPage: getActiveDocument()?.currentPage, ready: true });
      }
    } catch (error) {
      if (pendingFocus() === request) setPendingFocus(null);
      throw error;
    }
  };

  const handleReorder = async (fromPage, toPage, dropBefore) => {
    const { reorderPages } = await import('../../../../pdf/page-manager.js');
    const numPages = pageCount();
    const currentOrder = Array.from({ length: numPages }, (_, i) => i + 1);
    const fromIdx = currentOrder.indexOf(fromPage);
    currentOrder.splice(fromIdx, 1);
    let toIdx = currentOrder.indexOf(toPage);
    if (!dropBefore) toIdx++;
    currentOrder.splice(toIdx, 0, fromPage);
    await reorderPages(currentOrder);
  };

  const handleKeyDown = async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      selectAllPages();
    } else if (e.key === 'Escape') {
      clearPageSelection();
    } else if (e.key === 'Delete') {
      const selected = getSelectedPagesArray();
      if (selected.length > 0 && selected.length < pageCount()) {
        const rangeStr = formatPageRangeString(selected);
        const { openDialog } = await import('../../../stores/dialogStore.js');
        openDialog('delete-pages', {
          totalPages: pageCount(),
          currentPage: selected[0],
          pageRange: rangeStr
        });
      }
    }
  };

  return (
    <div class={`left-panel-content${activeTab() === 'thumbnails' ? ' active' : ''}`} id="thumbnails-panel">
      <div class="left-panel-header">
        <span>{t('leftPanel.thumbnails')}</span>
      </div>
      <div class="thumbnails-container" id="thumbnails-container" ref={(element) => { container = element; setContainerRef(element); }} tabIndex={0} onFocusOut={event => {
        // WebKit moves focus to the body when virtualization removes the old row.
        // Only an explicit move to another control cancels keyboard handoff.
        if (event.relatedTarget && event.relatedTarget !== document.body
            && event.relatedTarget !== document.documentElement
            && !container.contains(event.relatedTarget)) setPendingFocus(null);
      }} onKeyDown={handleKeyDown} onScroll={scheduleViewportUpdate}>
        <div class="thumbnail-virtual-spacer" style={{ height: `${mounted().topSpacer}px` }} />
        <For each={mounted().pages}>
          {(pageNum) => (
            <ThumbnailItem totalPages={pageCount()}
              pageNum={pageNum}
              onNavigate={handleNavigate}
              onReorder={handleReorder}
            />
          )}
        </For>
        <div class="thumbnail-virtual-spacer" style={{ height: `${mounted().bottomSpacer}px` }} />
        {/* Trailing "+" tile: append a new page (A4/A3/… chooser) to the PDF. */}
        <div
          class="thumbnail-item thumbnail-add-page"
          title={t('leftPanel.addPage') || 'Pagina toevoegen'}
          onClick={async () => {
            // Jump to the last page first so the insert dialog's "after
            // current page" default appends at the END of the document.
            const m = await import('../../../../pdf/renderer.js');
            await m.goToPage(pageCount());
            const { showInsertPageDialog } = await import('../../../../ui/chrome/dialogs.js');
            showInsertPageDialog();
          }}
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'min-height': '80px',
            border: '1px dashed var(--theme-border, #999)',
            color: 'var(--theme-text, #666)',
            'font-size': '28px',
            cursor: 'pointer',
            'user-select': 'none',
          }}
        >+</div>
      </div>
    </div>
  );
}

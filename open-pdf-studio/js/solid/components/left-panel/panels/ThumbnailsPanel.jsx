import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { pageCount, activePage, placeholderSize, pagePlaceholderSizes, selectAllPages, clearPageSelection, getSelectedPagesArray, formatPageRangeString, setContainerRef } from '../../../stores/panels/thumbnailStore.js';
import { activeTab } from '../../../stores/leftPanelStore.js';
import ThumbnailItem from '../ThumbnailItem.jsx';
import { useTranslation } from '../../../../i18n/useTranslation.js';
import { createThumbnailGeometry } from '../../../../ui/panels/thumbnail-virtualization.js';
import { recordPerformancePeak } from '../../../../pdf/performance-metrics.js';

export default function ThumbnailsPanel() {
  const { t } = useTranslation('properties');

  let container;
  let frame = 0;
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

  const handleNavigate = (pageNum) => {
    import('../../../../pdf/renderer.js').then(m => m.goToPage(pageNum));
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
    if (e.ctrlKey && e.key === 'a') {
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
      <div class="thumbnails-container" id="thumbnails-container" ref={(element) => { container = element; setContainerRef(element); }} tabIndex={0} onKeyDown={handleKeyDown} onScroll={scheduleViewportUpdate}>
        <div class="thumbnail-virtual-spacer" style={{ height: `${mounted().topSpacer}px` }} />
        <For each={mounted().pages}>
          {(pageNum) => (
            <ThumbnailItem
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

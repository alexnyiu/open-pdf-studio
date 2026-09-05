import { createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { state } from '../../core/state.js';
import { visible, message, documentId } from '../stores/loadingStore.js';
import { visible as notificationVisible } from '../stores/defaultAppBarStore.js';

export default function LoadingOverlay() {
  const [tabBottom, setTabBottom] = createSignal(0);
  const shown = () => visible() && (!documentId()
    || state.documents[state.activeDocumentIndex]?.id === documentId());
  let observer;
  let disposed = false;
  const updateBounds = () => setTabBottom(Math.max(0,
    document.getElementById('document-tabs')?.getBoundingClientRect().bottom || 0));
  createEffect(() => {
    documentId(); visible(); notificationVisible();
    queueMicrotask(() => { if (!disposed) updateBounds(); });
  });
  onMount(() => {
    updateBounds();
    observer = new ResizeObserver(updateBounds);
    for (const element of document.querySelectorAll('#document-tabs, .ribbon-container')) observer.observe(element);
    window.addEventListener('resize', updateBounds);
  });
  onCleanup(() => { disposed = true; observer?.disconnect(); window.removeEventListener('resize', updateBounds); });
  return (
    <div role="status" aria-live="polite" aria-busy={shown()} aria-hidden={!shown()}
      data-document-id={documentId() || undefined}
      style={documentId() ? { top: `${tabBottom()}px`, height: `calc(100% - ${tabBottom()}px)` } : undefined}
      class="loading-overlay" classList={{ visible: shown() }}>
      <div class="loading-content">
        <div class="loading-spinner"></div>
        <div class="loading-text">{message()}</div>
      </div>
    </div>
  );
}

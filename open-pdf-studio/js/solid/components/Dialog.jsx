import { createEffect, onMount, onCleanup } from 'solid-js';
import { useTranslation } from '../../i18n/useTranslation.js';
import { useModalStack } from './ModalStackContext.jsx';

// Track when the window last gained focus (shared across all Dialog instances)
let lastFocusTime = 0;
function onWindowFocus() { lastFocusTime = Date.now(); }
window.addEventListener('focus', onWindowFocus);

export default function Dialog(props) {
  const modalStack = useModalStack();
  const { t } = useTranslation('common');
  let overlayRef;
  let dialogRef;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let previouslyFocused;
  let wasTop = false;
  let focusFrame = null;

  const isTopModal = () => modalStack?.isTop?.() ?? true;

  function focusableElements() {
    if (!dialogRef) return [];
    return [...dialogRef.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getAttribute('aria-hidden') !== 'true');
  }

  function onHeaderMouseDown(e) {
    if (!isTopModal()) return;
    if (e.target.closest('.modal-close-btn')) return;
    isDragging = true;
    const rect = dialogRef.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isTopModal() || !isDragging) return;
    const overlayRect = overlayRef.getBoundingClientRect();
    let newX = e.clientX - overlayRect.left - dragOffsetX;
    let newY = e.clientY - overlayRect.top - dragOffsetY;
    const dialogRect = dialogRef.getBoundingClientRect();
    newX = Math.max(0, Math.min(newX, overlayRect.width - dialogRect.width));
    newY = Math.max(0, Math.min(newY, overlayRect.height - dialogRect.height));
    dialogRef.style.left = newX + 'px';
    dialogRef.style.top = newY + 'px';
    dialogRef.style.transform = 'none';
    dialogRef.style.position = 'absolute';
  }

  function onMouseUp() {
    if (!isTopModal()) return;
    isDragging = false;
  }

  // Keep the dialog inside the window. Runs after mount (dialog may be larger
  // than a small window — CSS centering would push the title bar off-screen)
  // and on window resize (a dragged dialog keeps absolute coords). Top-left
  // wins the clamp so the draggable title bar always stays reachable.
  function clampToViewport() {
    if (!dialogRef || !overlayRef) return;
    const overlayRect = overlayRef.getBoundingClientRect();
    const dialogRect = dialogRef.getBoundingClientRect();
    const curX = dialogRect.left - overlayRect.left;
    const curY = dialogRect.top - overlayRect.top;
    const newX = Math.max(0, Math.min(curX, overlayRect.width - dialogRect.width));
    const newY = Math.max(0, Math.min(curY, overlayRect.height - dialogRect.height));
    if (Math.abs(newX - curX) < 0.5 && Math.abs(newY - curY) < 0.5) return;
    dialogRef.style.left = newX + 'px';
    dialogRef.style.top = newY + 'px';
    dialogRef.style.transform = 'none';
    dialogRef.style.position = 'absolute';
  }

  function onKeyDown(e) {
    if (!isTopModal()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose?.();
      return;
    }
    if (e.key === 'Tab' && props.trapFocus !== false) {
      const focusable = focusableElements();
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialogRef.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function triggerBump() {
    if (!dialogRef) return;
    // Remove class first to allow re-triggering
    dialogRef.classList.remove('bump');
    // Force reflow so the animation restarts
    void dialogRef.offsetWidth;
    dialogRef.classList.add('bump');
    // Play system alert sound via Rust backend
    if (window.__TAURI__?.core?.invoke) {
      window.__TAURI__.core.invoke('play_alert_sound').catch(() => {});
    }
  }

  function onOverlayMouseDown(e) {
    if (!isTopModal()) return;
    // If the window just gained focus from this click, only activate — don't interact
    if (Date.now() - lastFocusTime < 300) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Only trigger bump if click is directly on the overlay (not the dialog)
    if (e.target === overlayRef) {
      e.preventDefault();
      e.stopPropagation();
      triggerBump();
    }
  }

  function onOverlayDblClick(e) {
    if (!isTopModal()) return;
    // Block double-click on overlay from reaching the window behind
    if (e.target === overlayRef) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  onMount(() => {
    previouslyFocused = document.activeElement;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', clampToViewport);
  });

  createEffect(() => {
    const top = isTopModal();
    if (overlayRef) {
      overlayRef.inert = !top;
      if (top) overlayRef.removeAttribute('aria-hidden');
      else overlayRef.setAttribute('aria-hidden', 'true');
    }
    if (top && !wasTop) {
      if (focusFrame !== null) cancelAnimationFrame(focusFrame);
      const initial = props.initialFocusSelector
        ? dialogRef?.querySelector(props.initialFocusSelector)
        : null;
      // Establish modal focus in the same reactive turn. A fast asynchronous
      // readiness update must not make the dialog actionable while focus is
      // still parked on the document body waiting for the next frame.
      (initial || focusableElements()[0] || dialogRef)?.focus?.();
      focusFrame = requestAnimationFrame(() => {
        focusFrame = null;
        clampToViewport();
      });
    }
    if (!top) isDragging = false;
    wasTop = top;
  });

  onCleanup(() => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', clampToViewport);
    if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    if (dialogRef?.contains(document.activeElement) && previouslyFocused?.isConnected) {
      previouslyFocused.focus?.();
    }
  });

  return (
    <div
      ref={overlayRef}
      class={`modal-overlay ${props.overlayClass || ''}`}
      style="display:flex"
      onMouseDown={onOverlayMouseDown}
      onDblClick={onOverlayDblClick}
    >
      <div
        ref={dialogRef}
        class={`modal-dialog ${props.dialogClass || ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabindex="-1"
        onAnimationEnd={() => dialogRef?.classList.remove('bump')}
      >
        <div
          class={`modal-header ${props.headerClass || ''}`}
          onMouseDown={onHeaderMouseDown}
        >
          <h2>{props.title}</h2>
          <button type="button" class="modal-close-btn" aria-label={props.closeLabel || t('close')} onClick={() => props.onClose?.()}>
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>
        <div class={`modal-body ${props.bodyClass || ''}`}>
          {props.children}
        </div>
        {props.footer && (
          <div class={`modal-footer ${props.footerClass || ''}`}>
            {props.footer}
          </div>
        )}
      </div>
    </div>
  );
}

import { onMount, onCleanup } from 'solid-js';

// Track when the window last gained focus (shared across all Dialog instances)
let lastFocusTime = 0;
function onWindowFocus() { lastFocusTime = Date.now(); }
window.addEventListener('focus', onWindowFocus);

export default function Dialog(props) {
  let overlayRef;
  let dialogRef;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  function onHeaderMouseDown(e) {
    if (e.target.closest('.modal-close-btn')) return;
    isDragging = true;
    const rect = dialogRef.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isDragging) return;
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
    if (!dialogRef?.contains(document.activeElement)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose?.();
      return;
    }

    if (e.key === 'Tab') {
      const focusable = [...dialogRef.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )].filter(el => el.getClientRects().length > 0);
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  }

  function focusInitialControl() {
    if (!dialogRef) return;
    const initial = dialogRef.querySelector('[autofocus], [data-dialog-autofocus]')
      || dialogRef.querySelector(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
    if (initial) {
      initial.focus({ preventScroll: true });
    } else {
      dialogRef.focus({ preventScroll: true });
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
    // Block double-click on overlay from reaching the window behind
    if (e.target === overlayRef) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  onMount(() => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', clampToViewport);
    // Clamp after first layout (content height is only known then)
    requestAnimationFrame(() => {
      clampToViewport();
      focusInitialControl();
    });
  });

  onCleanup(() => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', clampToViewport);
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
        role={props.role || 'dialog'}
        aria-modal="true"
        aria-label={props.title}
        tabindex="-1"
        data-phase8-dialog="true"
        onAnimationEnd={() => dialogRef?.classList.remove('bump')}
      >
        <div
          class={`modal-header ${props.headerClass || ''}`}
          onMouseDown={onHeaderMouseDown}
        >
          <h2>{props.title}</h2>
          <button class="modal-close-btn" onClick={() => props.onClose?.()}>
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

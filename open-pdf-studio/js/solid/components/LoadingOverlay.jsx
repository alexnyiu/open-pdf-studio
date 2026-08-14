import { visible, message } from '../stores/loadingStore.js';

export default function LoadingOverlay() {
  return (
    <div
      class="loading-overlay"
      classList={{ visible: visible() }}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={visible() ? 'true' : 'false'}
      data-phase8="busy-progress"
    >
      <div class="loading-content">
        <div
          class="loading-spinner"
          role="progressbar"
          aria-label={message()}
          aria-valuetext={message()}
        ></div>
        <div class="loading-text">{message()}</div>
      </div>
    </div>
  );
}

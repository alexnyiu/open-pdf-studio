import { createEffect, createSignal } from 'solid-js';
import {
  visible, resultsText, messageText, notFound, navDisabled, searching,
} from '../stores/findBarStore.js';
import { useTranslation } from '../../i18n/useTranslation.js';

export default function FindBar() {
  const { t } = useTranslation('statusbar');
  let inputRef;

  const [matchCase, setMatchCase] = createSignal(false);
  const [wholeWord, setWholeWord] = createSignal(false);
  const [highlightAll, setHighlightAll] = createSignal(true);

  // Focus input when find bar becomes visible
  createEffect(() => {
    if (visible()) {
      setTimeout(() => {
        inputRef?.focus();
        inputRef?.select();
      }, 0);
    }
  });

  const handleClose = () => {
    import('../../search/find-bar.js').then(m => m.closeFindBar());
  };

  const handleInput = (e) => {
    import('../../search/find-bar.js').then(m => m.handleSearchInput(e.target.value));
  };

  const handleKeyDown = (e) => {
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) {
          import('../../search/find-bar.js').then(m => m.onFindPrevious());
        } else {
          import('../../search/find-bar.js').then(m => m.onFindNext());
        }
        break;
      case 'Escape':
        e.preventDefault();
        handleClose();
        break;
    }
  };

  const handlePrev = () => {
    import('../../search/find-bar.js').then(m => m.onFindPrevious());
  };

  const handleNext = () => {
    import('../../search/find-bar.js').then(m => m.onFindNext());
  };

  const fireOptionsChange = (mc, ww) => {
    import('../../search/find-bar.js').then(m => m.onOptionsChange({
      matchCase: mc,
      wholeWord: ww,
    }));
  };

  const toggleMatchCase = () => {
    const v = !matchCase();
    setMatchCase(v);
    fireOptionsChange(v, wholeWord());
  };

  const toggleWholeWord = () => {
    const v = !wholeWord();
    setWholeWord(v);
    fireOptionsChange(matchCase(), v);
  };

  const toggleHighlightAll = () => {
    const v = !highlightAll();
    setHighlightAll(v);
    import('../../search/find-bar.js').then(m => m.onHighlightChange(v));
  };

  return (
    <div class="find-bar" classList={{ visible: visible() }}>
      <div class="find-rows">
        {/* Row 1: Find */}
        <div class="find-row">
          {/* Search input with inline count */}
          <div class="find-input-wrapper" classList={{ 'not-found': notFound() }}>
            <input
              class="find-input"
              aria-label={t('findPlaceholder')} aria-busy={searching()} placeholder={t('findPlaceholder')}
              autocomplete="off"
              ref={inputRef}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
            />
            <span role="status" aria-live="polite" aria-atomic="true" class="find-count-inline" classList={{ 'is-searching': searching() }}>
              {resultsText()}
            </span>
          </div>

          {/* Nav buttons */}
          <button class="find-btn" title={t('previousShiftEnter')} disabled={navDisabled()} onClick={handlePrev}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M11 13L5.5 8 11 3"/>
            </svg>
          </button>
          <button class="find-btn" title={t('nextEnter')} disabled={navDisabled()} onClick={handleNext}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M5 3l5.5 5L5 13"/>
            </svg>
          </button>

          <div class="find-separator" />

          {/* Toggle buttons (icon-only) */}
          <button
            class="find-toggle-btn"
            aria-pressed={matchCase()} classList={{ active: matchCase() }}
            title={t('matchCase')}
            onClick={toggleMatchCase}
          >Aa</button>

          <button
            class="find-toggle-btn"
            aria-pressed={wholeWord()} classList={{ active: wholeWord() }}
            title={t('wholeWords')}
            onClick={toggleWholeWord}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M1 3h2v1H2v8h1v1H1V3zm12 0h2v10h-2v-1h1V4h-1V3zM5.2 11L4.5 9H7l-.7 2h1.1l2-6H8.2l.5-1h2.7l-.5 1H9.8l-2 6H5.2zM5.1 8l.7-2.2L6.5 8H5.1z"/>
            </svg>
          </button>

          <button
            class="find-toggle-btn"
            aria-pressed={highlightAll()} classList={{ active: highlightAll() }}
            title={t('highlightAll')}
            onClick={toggleHighlightAll}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M11.3 1.3l3.4 3.4c.4.4.4 1 0 1.4L7.4 13.4c-.2.2-.4.3-.7.3H3.3c-.5 0-1-.4-1-1V9.3c0-.3.1-.5.3-.7L9.9 1.3c.4-.4 1-.4 1.4 0zM4.3 9.7v2h2l6.3-6.3-2-2-6.3 6.3z"/>
            </svg>
          </button>

          {/* Close */}
          <button class="find-close-btn" title={t('closeEsc')} onClick={handleClose}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 3l10 10M13 3L3 13"/>
            </svg>
          </button>
        </div>

      </div>

      {/* Not found message */}
      {notFound() && <span class="find-message">{messageText()}</span>}
    </div>
  );
}

import { createSignal, For, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';

let nextLanguageSelectId = 0;

export default function LanguageSelect(props) {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal('');
  const [style, setStyle] = createSignal({});
  let wrapperRef, dropdownRef, searchRef, triggerRef;
  const dropdownId = props.id ? `${props.id}-options` : `language-select-options-${++nextLanguageSelectId}`;
  const optionRefs = [];

  const displayLabel = () => {
    const val = props.value();
    const opt = props.options.find(o => o.value === val);
    return opt ? opt.label : String(val);
  };

  const filtered = () => {
    const q = filter().toLowerCase();
    if (!q) return props.options;
    return props.options.filter(o => o.label.toLowerCase().includes(q));
  };

  function position() {
    if (!wrapperRef) return;
    const rect = wrapperRef.getBoundingClientRect();
    const maxH = 280;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 200 && rect.top > spaceBelow;
    const s = {
      position: 'fixed',
      left: (rect.left - 1) + 'px',
      width: '260px',
      'overflow-y': 'auto',
    };
    if (openUp) {
      s.bottom = (window.innerHeight - rect.top) + 'px';
      s['max-height'] = Math.min(rect.top - 4, maxH) + 'px';
    } else {
      s.top = rect.bottom + 'px';
      s['max-height'] = Math.min(spaceBelow - 4, maxH) + 'px';
    }
    setStyle(s);
  }

  function toggle(e) {
    e.preventDefault();
    const willOpen = !open();
    if (willOpen) {
      setFilter('');
      position();
    }
    setOpen(willOpen);
    if (willOpen) {
      requestAnimationFrame(() => {
        if (searchRef) searchRef.focus();
        if (dropdownRef) {
          const sel = dropdownRef.querySelector('.selected');
          if (sel) sel.scrollIntoView({ block: 'nearest' });
        }
      });
    }
  }

  function select(val) {
    props.setValue(val);
    setOpen(false);
    triggerRef?.focus();
  }

  function focusOption(index) {
    optionRefs[index]?.focus();
  }

  function handleTriggerKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open()) toggle(e);
      requestAnimationFrame(() => searchRef?.focus());
    } else if (e.key === 'Escape' && open()) {
      e.preventDefault();
      setOpen(false);
    }
  }

  function handleSearchKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusOption(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusOption(Math.max(0, filtered().length - 1));
    }
  }

  function handleOptionKeyDown(e, index) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (index + direction + filtered().length) % filtered().length;
      focusOption(nextIndex);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusOption(e.key === 'Home' ? 0 : filtered().length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(filtered()[index].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef?.focus();
    }
  }

  function handleDocClick(e) {
    if (wrapperRef && !wrapperRef.contains(e.target) &&
        dropdownRef && !dropdownRef.contains(e.target)) {
      setOpen(false);
    }
  }

  onMount(() => document.addEventListener('mousedown', handleDocClick));
  onCleanup(() => document.removeEventListener('mousedown', handleDocClick));

  return (
    <div class="pref-combo" role="combobox" aria-haspopup="listbox" aria-expanded={open() ? 'true' : 'false'}
      aria-controls={dropdownId} style={props.style} ref={wrapperRef}>
      <button type="button" class="pref-select-trigger" ref={triggerRef}
        aria-label={props.ariaLabel || 'Language'} aria-haspopup="listbox"
        aria-expanded={open() ? 'true' : 'false'} aria-controls={dropdownId}
        onClick={toggle} onKeyDown={handleTriggerKeyDown}>
        <span class="pref-select-display">{displayLabel()}</span>
        <svg class="pref-combo-arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      <Portal>
        <div id={dropdownId} class="pref-combo-dropdown lang-select-dropdown" role="listbox" aria-label={props.ariaLabel || 'Language options'} classList={{ show: open() }}
          style={style()} ref={dropdownRef}>
          <div class="lang-select-search">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search..."
              value={filter()}
              onInput={e => setFilter(e.target.value)}
              aria-label="Search languages"
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <div class="lang-select-list">
            <For each={filtered()}>
              {(opt, index) => (
                <button type="button" role="option"
                  class="pref-combo-option"
                  classList={{ selected: props.value() === opt.value }}
                  aria-selected={props.value() === opt.value ? 'true' : 'false'}
                  ref={el => { optionRefs[index()] = el; }}
                  onClick={() => select(opt.value)}
                  onKeyDown={e => handleOptionKeyDown(e, index())}
                >
                  {opt.label}
                </button>
              )}
            </For>
            {filtered().length === 0 && <div class="pref-combo-option" role="presentation" aria-hidden="true" style="opacity:0.5;pointer-events:none">No results</div>}
          </div>
        </div>
      </Portal>
    </div>
  );
}

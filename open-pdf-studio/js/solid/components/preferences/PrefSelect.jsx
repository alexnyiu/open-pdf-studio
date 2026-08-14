import { Portal } from 'solid-js/web';
import useDropdown from './useDropdown.js';

let nextPrefSelectId = 0;

export default function PrefSelect(props) {
  const { open, setOpen, dropdownStyle, setWrapperRef, setDropdownRef, toggleDropdown } =
    useDropdown(() => props.options.length);
  const dropdownId = props.id ? `${props.id}-options` : `pref-select-options-${++nextPrefSelectId}`;
  let triggerRef;
  const optionRefs = [];

  const isDisabled = () => typeof props.disabled === 'function' ? props.disabled() : !!props.disabled;

  const displayLabel = () => {
    const val = props.value();
    const opt = props.options.find(o => o.value === val);
    return opt ? opt.label : String(val);
  };

  function selectOption(val) {
    if (isDisabled()) return;
    props.setValue(val);
    setOpen(false);
    triggerRef?.focus();
  }

  function focusSelectedOption() {
    const selectedIndex = props.options.findIndex(option => option.value === props.value());
    const option = optionRefs[selectedIndex >= 0 ? selectedIndex : 0];
    option?.focus();
  }

  function handleTriggerClick(e) {
    const wasOpen = open();
    toggleDropdown(e, isDisabled());
    if (!wasOpen) requestAnimationFrame(focusSelectedOption);
  }

  function toggleFromKeyboard(e) {
    if (isDisabled()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open()) {
        toggleDropdown(e, false);
        requestAnimationFrame(focusSelectedOption);
      } else {
        focusSelectedOption();
      }
    } else if (e.key === 'Escape' && open()) {
      e.preventDefault();
      setOpen(false);
    }
  }

  function handleOptionKeyDown(e, index) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const direction = e.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (index + direction + props.options.length) % props.options.length;
      optionRefs[nextIndex]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      optionRefs[e.key === 'Home' ? 0 : props.options.length - 1]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectOption(props.options[index].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef?.focus();
    }
  }

  return (
    <div class="pref-combo" classList={{ disabled: isDisabled() }} role="combobox" aria-haspopup="listbox"
      aria-expanded={open() ? 'true' : 'false'} aria-controls={dropdownId} style={props.style} ref={setWrapperRef}>
      <button type="button" class="pref-select-trigger" ref={triggerRef}
        aria-label={props.ariaLabel} aria-labelledby={props.ariaLabelledby}
        aria-haspopup="listbox" aria-expanded={open() ? 'true' : 'false'} aria-controls={dropdownId}
        disabled={isDisabled()} onClick={handleTriggerClick} onKeyDown={toggleFromKeyboard}>
        <span class="pref-select-display">{displayLabel()}</span>
        <svg class="pref-combo-arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      <Portal>
        <div id={dropdownId} class="pref-combo-dropdown" role="listbox" aria-label={props.ariaLabel || 'Options'} classList={{ show: open() }}
          style={dropdownStyle()} ref={setDropdownRef}>
          {props.options.map((opt, index) => (
            <button type="button" role="option"
              class="pref-combo-option"
              classList={{ selected: props.value() === opt.value }}
              aria-selected={props.value() === opt.value ? 'true' : 'false'}
              ref={el => { optionRefs[index] = el; }}
              onClick={() => selectOption(opt.value)}
              onKeyDown={e => handleOptionKeyDown(e, index)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Portal>
    </div>
  );
}

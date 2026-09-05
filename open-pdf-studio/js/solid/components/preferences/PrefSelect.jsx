import { createUniqueId, onMount, For } from 'solid-js';

export default function PrefSelect(props) {
  const id = props.id || `preference-${createUniqueId()}`;
  let select;
  onMount(() => {
    // Existing preference rows already own translated labels.
    const label = select?.closest('.pref-row')?.querySelector('label');
    if (label && !label.htmlFor) label.htmlFor = id;
  });
  return <select ref={select} id={id} class="pref-native-select" style={props.style}
    aria-label={props.label} value={props.value()}
    disabled={typeof props.disabled === 'function' ? props.disabled() : !!props.disabled}
    onChange={event => {
      const option = props.options.find(item => String(item.value) === event.currentTarget.value);
      if (option) props.setValue(option.value);
    }}>
    <For each={props.options}>{option => <option value={String(option.value)}>{option.label}</option>}</For>
  </select>;
}

export default function UiSegmentedControl(props) {
  return (
    <div class="ui-segmented-control" role="group" aria-label={props.label}>
      {props.items.map(item => (
        <button
          type="button"
          class={item.value === props.value ? 'is-selected' : ''}
          aria-pressed={item.value === props.value ? 'true' : 'false'}
          onClick={() => props.onChange?.(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

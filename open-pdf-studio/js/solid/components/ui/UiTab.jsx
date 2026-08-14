export default function UiTab(props) {
  return (
    <button
      type="button"
      class={`ui-tab${props.active ? ' is-active' : ''}${props.class ? ` ${props.class}` : ''}`}
      id={props.id}
      data-tab={props.dataTab}
      aria-selected={props.active ? 'true' : 'false'}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

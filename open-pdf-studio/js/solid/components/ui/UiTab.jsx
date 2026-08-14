export default function UiTab(props) {
  return (
    <button
      type="button"
      class={`ui-tab${props.active ? ' is-active' : ''}${props.class ? ` ${props.class}` : ''}`}
      id={props.id}
      data-tab={props.dataTab}
      role={props.isFileTab ? 'button' : 'tab'}
      aria-selected={props.isFileTab ? undefined : (props.active ? 'true' : 'false')}
      tabIndex={props.isFileTab || props.active ? 0 : -1}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

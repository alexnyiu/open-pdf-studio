export default function UiToolbarGroup(props) {
  return (
    <div class={`ui-toolbar-group${props.class ? ` ${props.class}` : ''}`}>
      {props.children}
      {props.label && <div class={props.labelClass || 'ui-toolbar-group-label'}>{props.label}</div>}
    </div>
  );
}

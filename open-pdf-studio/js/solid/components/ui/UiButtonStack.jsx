export default function UiButtonStack(props) {
  return <div class={`ui-button-stack${props.class ? ` ${props.class}` : ''}`}>{props.children}</div>;
}

import UiButton from './UiButton.jsx';

export default function UiIconButton(props) {
  return (
    <UiButton
      {...props}
      iconOnly={true}
      ariaLabel={props.ariaLabel || props.title}
      class={`ui-icon-button${props.class ? ` ${props.class}` : ''}`}
    />
  );
}

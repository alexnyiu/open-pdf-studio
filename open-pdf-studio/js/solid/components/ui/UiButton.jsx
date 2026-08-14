/**
 * Presentation-only button primitive.
 *
 * It owns no document behavior. Consumers supply the existing callback and
 * preserve their own legacy class/ID contracts through `class` and `id`.
 */
export default function UiButton(props) {
  const label = props.label ?? props.children;
  const buttonClass = () => [
    'ui-button',
    `ui-button-${props.variant || 'quiet'}`,
    props.size ? `ui-button-${props.size}` : '',
    props.active ? 'is-active' : '',
    props.iconOnly ? 'is-icon-only' : '',
    props.busy ? 'is-busy' : '',
    props.class || ''
  ].filter(Boolean).join(' ');

  return (
    <button
      type={props.type}
      class={buttonClass()}
      id={props.id}
      title={props.title}
      aria-label={props.ariaLabel || (props.iconOnly ? props.title : undefined)}
      aria-pressed={props.pressed}
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
      style={props.style}
    >
      {props.icon && (
        <div
          class={`ui-button-icon${props.iconClass ? ` ${props.iconClass}` : ''}`}
          style={props.iconStyle}
          aria-hidden={props.iconOnly ? 'true' : undefined}
          ref={el => { el.innerHTML = props.icon; }}
        />
      )}
      {!props.iconOnly && label != null && (
        <span class={`ui-button-label${props.labelClass ? ` ${props.labelClass}` : ''}`} ref={props.labelRef}>
          {label}
        </span>
      )}
      {props.busy && <span class="ui-button-busy" aria-hidden="true" />}
    </button>
  );
}

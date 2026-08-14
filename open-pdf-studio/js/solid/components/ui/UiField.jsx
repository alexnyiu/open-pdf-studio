export default function UiField(props) {
  return (
    <label class={`ui-field${props.state ? ` is-${props.state}` : ''}${props.class ? ` ${props.class}` : ''}`}>
      {props.label && <span class="ui-field-label">{props.label}</span>}
      <input
        type={props.type || 'text'}
        value={props.value}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        readOnly={props.readOnly}
        aria-label={props.ariaLabel || props.label}
        onInput={props.onInput}
      />
      {props.helper && <span class="ui-field-helper">{props.helper}</span>}
    </label>
  );
}

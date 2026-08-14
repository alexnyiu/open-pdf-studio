/**
 * Presentation-only button primitive.
 *
 * It owns no document behavior. Consumers supply the existing callback and
 * preserve their own legacy class/ID contracts through `class` and `id`.
 */
export default function UiButton(props) {
  const label = props.label ?? props.children;
  const titleText = () => props.title == null ? '' : String(props.title);
  const shortcutMatch = () => titleText().match(/^(.*)\s+\(([^()]+)\)$/);
  const inferredShortcut = () => {
    const match = shortcutMatch();
    return match && /(?:Ctrl|Cmd|Control|Meta|Alt|Option|Shift|⌘|⌥|⇧|⌃)/i.test(match[2])
      ? match[2]
      : '';
  };
  const tooltipLabel = () => {
    if (props.tooltip != null) return props.tooltip;
    const match = shortcutMatch();
    if (match && inferredShortcut()) return match[1];
    return props.shortcut ? titleText() : '';
  };
  const shortcutLabel = () => props.shortcut || inferredShortcut();
  const displayShortcut = () => {
    const shortcut = shortcutLabel();
    if (!shortcut || typeof navigator === 'undefined' || !/Mac|iPhone|iPad/i.test(navigator.platform)) {
      return shortcut;
    }
    return shortcut
      .replace(/\bCtrl\b/gi, '⌘')
      .replace(/\bCmd\b/gi, '⌘')
      .replace(/\bControl\b/gi, '⌘')
      .replace(/\bShift\b/gi, '⇧')
      .replace(/\bAlt\b|\bOption\b/gi, '⌥')
      .replace(/\+/g, '');
  };
  const ariaShortcut = () => {
    if (props.ariaKeyshortcuts) return props.ariaKeyshortcuts;
    const shortcut = shortcutLabel();
    if (!shortcut) return undefined;
    const normalized = shortcut.replace(/\bCtrl\b/gi, 'Control').replace(/\bCmd\b/gi, 'Meta');
    return normalized.match(/^Control\+/i)
      ? `${normalized} ${normalized.replace(/^Control/i, 'Meta')}`
      : normalized;
  };
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
      aria-label={props.ariaLabel || (props.iconOnly ? (tooltipLabel() || props.title) : undefined)}
      aria-pressed={props.pressed}
      aria-keyshortcuts={ariaShortcut()}
      aria-busy={props.busy ? 'true' : undefined}
      data-ui-tooltip={tooltipLabel() || undefined}
      data-ui-shortcut={displayShortcut() || undefined}
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

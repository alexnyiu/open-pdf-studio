import { autoShrinkLabel } from './autoShrinkLabel.js';
import UiButton from '../ui/UiButton.jsx';

export default function RibbonButton(props) {
  return (
    <UiButton
      class={`ribbon-btn${props.size === 'small' ? ' small' : ''}${props.size === 'medium' ? ' medium' : ''}${props.active ? ' active' : ''}${props.iconOnly ? ' icon-only' : ''}${props.extraClass ? ' ' + props.extraClass : ''}`}
      variant="quiet"
      active={props.active}
      iconOnly={props.iconOnly}
      id={props.id}
      title={props.title}
      tooltip={props.tooltip}
      shortcut={props.shortcut}
      ariaKeyshortcuts={props.ariaKeyshortcuts}
      ariaLabel={props.iconOnly ? props.title : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      style={props.style}
      icon={props.icon}
      iconStyle={props.iconStyle}
      iconClass="ribbon-btn-icon"
      labelClass="ribbon-btn-label"
      labelRef={el => autoShrinkLabel(el)}
      label={props.label}
    />
  );
}

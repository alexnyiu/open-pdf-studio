import UiToolbarGroup from '../ui/UiToolbarGroup.jsx';

export default function RibbonGroup(props) {
  return (
    <UiToolbarGroup
      class={`ribbon-group${props.wide ? ' ribbon-group-wide' : ''}${props.compact ? ' ribbon-group-compact' : ''}${props.iconOnly ? ' ribbon-group-icon-only' : ''}`}
      label={props.label || ''}
      labelClass="ribbon-group-label"
    >
      <div class="ribbon-group-content">{props.children}</div>
    </UiToolbarGroup>
  );
}

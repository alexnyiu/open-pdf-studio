import UiIconButton from './UiIconButton.jsx';

export default function UiPanelHeader(props) {
  return (
    <div id={props.id} class={`ui-panel-header${props.class ? ` ${props.class}` : ''}`}>
      {props.onCollapse && (
        <UiIconButton
          class="ui-panel-collapse-button"
          title={props.collapseLabel}
          ariaLabel={props.collapseLabel}
          icon={props.collapseIcon}
          onClick={props.onCollapse}
        />
      )}
      <h3 class="ui-panel-title">{props.title}</h3>
      {props.actions}
    </div>
  );
}

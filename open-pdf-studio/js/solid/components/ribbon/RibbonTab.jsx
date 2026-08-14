import UiTab from '../ui/UiTab.jsx';

export default function RibbonTab(props) {
  return (
    <UiTab
      class={`ribbon-tab${props.isActive ? ' active' : ''}${props.isFileTab ? ' file-tab' : ''}${props.isContextual ? ' contextual-tab contextual-tabs visible' : ''}`}
      active={props.isActive}
      dataTab={props.dataTab}
      id={props.id}
      label={props.label}
      isFileTab={props.isFileTab}
      onClick={props.onClick}
    />
  );
}

import { activeTab } from '../../stores/leftPanelStore.js';
import { switchLeftPanelTab } from '../../../ui/panels/left-panel.js';

export default function LeftPanelTab(props) {
  return (
    <button
      class={`left-panel-tab${activeTab() === props.panelId ? ' active' : ''}`}
      data-panel={props.panelId}
      title={props.title}
      aria-label={props.label}
      aria-pressed={activeTab() === props.panelId}
      onClick={() => switchLeftPanelTab(props.panelId)}
    >
      <span innerHTML={props.icon}></span>
      <span class="tab-label">{props.label}</span>
    </button>
  );
}

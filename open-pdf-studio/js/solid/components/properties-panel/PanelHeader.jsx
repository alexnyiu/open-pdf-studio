import { setPanelCollapsed } from '../../stores/propertiesStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import UiPanelHeader from '../ui/UiPanelHeader.jsx';

const collapseIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/></svg>';

export default function PanelHeader() {
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');

  return (
    <UiPanelHeader
      id="prop-panel-header"
      class="prop-panel-header"
      title={t('title')}
      collapseLabel={tCommon('collapse')}
      collapseIcon={collapseIcon}
      onCollapse={() => setPanelCollapsed(true)}
    />
  );
}

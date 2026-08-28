import { useTranslation } from '../../../i18n/useTranslation.js';

export default function PageDisplayTab(props) {
  const { t } = useTranslation('preferences');
  const p = props.prefs;
  return (
    <>
      <fieldset class="pref-fieldset">
        <legend>{t('pageDisplay.rendering')}</legend>
        <div class="pref-row pref-checkbox-row">
          <label class="pref-checkbox-label">
            <input type="checkbox" checked={p.thinLines[0]()} onChange={e => p.thinLines[1](e.target.checked)} />
            <span>{t('pageDisplay.thinLines')}</span>
          </label>
        </div>
        <div class="pref-row">
          <label for="pdf-preload-mode">{t('pageDisplay.preloadMode')}</label>
          <select
            id="pdf-preload-mode"
            value={p.pdfPreloadMode[0]()}
            onChange={e => p.pdfPreloadMode[1](e.currentTarget.value)}
          >
            <option value="adaptive">{t('pageDisplay.preloadAdaptive')}</option>
            <option value="entire">{t('pageDisplay.preloadEntire')}</option>
            <option value="off">{t('pageDisplay.preloadOff')}</option>
          </select>
          <small class="pref-description">{t('pageDisplay.preloadModeDescription')}</small>
        </div>
        <div class="pref-row pref-checkbox-row">
          <label class="pref-checkbox-label">
            <input type="checkbox" checked={p.showScrollbars[0]()} onChange={e => p.showScrollbars[1](e.target.checked)} />
            <span>{t('pageDisplay.showScrollbars')}</span>
          </label>
        </div>
        <div class="pref-row pref-checkbox-row">
          <label class="pref-checkbox-label">
            <input type="checkbox" checked={p.progressiveRender[0]()} onChange={e => p.progressiveRender[1](e.target.checked)} />
            <span>{t('pageDisplay.progressiveRender')}</span>
          </label>
        </div>
      </fieldset>
      <fieldset class="pref-fieldset">
        <legend>{t('pageDisplay.panels')}</legend>
        <div class="pref-row pref-checkbox-row">
          <label class="pref-checkbox-label">
            <input type="checkbox" checked={p.propertiesPanelVisible[0]()} onChange={e => p.propertiesPanelVisible[1](e.target.checked)} />
            <span>{t('pageDisplay.showPropertiesPanel')}</span>
          </label>
        </div>
        <div class="pref-row pref-checkbox-row">
          <label class="pref-checkbox-label">
            <input type="checkbox" checked={p.toolPaletteVisible[0]()} onChange={e => p.toolPaletteVisible[1](e.target.checked)} />
            <span>{t('pageDisplay.showToolPalette')}</span>
          </label>
        </div>
      </fieldset>
    </>
  );
}

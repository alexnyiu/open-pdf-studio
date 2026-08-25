import { Show } from 'solid-js';
import { annotProps, sectionVis, updateAnnotProp } from '../../stores/propertiesStore.js';
import CollapsibleSection from './CollapsibleSection.jsx';
import PrefComboBox from '../preferences/PrefComboBox.jsx';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { mixedFormatState, richTextDocument } from '../../stores/pdfTextEditStore.js';

export default function ParagraphSection() {
  const { t } = useTranslation('properties');
  const isLocked = () => annotProps.locked === true || annotProps.locked === 'mixed';
  const alignment = () => richTextDocument()
    ? (mixedFormatState().alignment ?? 'mixed') : annotProps.textAlign;

  return (
    <Show when={sectionVis.paragraph}>
      <CollapsibleSection title={t('paragraph.title')} name="paragraph" id="prop-paragraph-section">
        <div class="property-group">
          <label>{t('paragraph.textAlignment')}</label>
          <div class="text-align-buttons">
            <button type="button"
              class={`text-align-btn${alignment() === 'left' ? ' active' : ''}${alignment() === 'mixed' ? ' mixed' : ''}`}
              title={t('paragraph.alignLeft')} disabled={isLocked()}
              onClick={() => updateAnnotProp('textAlign', 'left')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M3 12h12M3 18h18"/>
              </svg>
            </button>
            <button type="button"
              class={`text-align-btn${alignment() === 'center' ? ' active' : ''}${alignment() === 'mixed' ? ' mixed' : ''}`}
              title={t('paragraph.alignCenter')} disabled={isLocked()}
              onClick={() => updateAnnotProp('textAlign', 'center')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M6 12h12M3 18h18"/>
              </svg>
            </button>
            <button type="button"
              class={`text-align-btn${alignment() === 'right' ? ' active' : ''}${alignment() === 'mixed' ? ' mixed' : ''}`}
              title={t('paragraph.alignRight')} disabled={isLocked()}
              onClick={() => updateAnnotProp('textAlign', 'right')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M9 12h12M3 18h18"/>
              </svg>
            </button>
          </div>
        </div>

        <Show when={annotProps.scannedTextEstimate !== true}>
          <div class="property-group">
            <label>{t('paragraph.lineSpacing')}</label>
            <PrefComboBox
              value={() => annotProps.lineSpacing}
              setValue={(val) => updateAnnotProp('lineSpacing', val)}
              options={[1, 1.15, 1.5, 2, 2.5, 3]}
              min={0.5} max={5} fallback={1.5} suffix="x"
              disabled={isLocked}
            />
          </div>

          <div class="property-group">
            <label>{t('paragraph.rotation')}</label>
            <PrefComboBox
              value={() => annotProps.rotation}
              setValue={(val) => updateAnnotProp('rotation', val)}
              options={[0, 45, 90, 135, 180, 225, 270, 315]}
              min={-360} max={360} fallback={0} suffix="°"
              disabled={isLocked}
            />
          </div>
        </Show>
      </CollapsibleSection>
    </Show>
  );
}

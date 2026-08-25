import { Show, For, createMemo } from 'solid-js';
import { annotProps, sectionVis, updateAnnotProp, cycleSelectNext, panelMode } from '../../stores/propertiesStore.js';
import CollapsibleSection from './CollapsibleSection.jsx';
import ColorPalettePicker from './ColorPalettePicker.jsx';
import PrefComboBox from '../preferences/PrefComboBox.jsx';
import { systemFontList } from '../../stores/fontStore.js';
import { ensureFontInStore } from '../../../utils/fonts.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { mixedFormatState, richTextDocument } from '../../stores/pdfTextEditStore.js';

const FONT_SIZE_OPTIONS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

export default function TextFormatSection() {
  const { t } = useTranslation('properties');
  const { t: tCommon } = useTranslation('common');
  const isLocked = () => annotProps.locked === true || annotProps.locked === 'mixed';
  const richActive = () => Boolean(richTextDocument());
  const richValue = (key, fallback) => richActive()
    ? (mixedFormatState()[key] ?? 'mixed') : fallback;
  const richFontFamily = () => {
    if (!richActive()) return annotProps.fontFamily;
    const faceId = richValue('faceId', annotProps.fontFamily);
    if (faceId === 'mixed') return 'mixed';
    if (String(faceId).includes('mono')) return 'Liberation Mono';
    if (String(faceId).includes('serif')) return 'Liberation Serif';
    return 'Liberation Sans';
  };

  const fonts = createMemo(() => {
    if (richActive() || annotProps.scannedTextEstimate === true) {
      return ['Liberation Sans', 'Liberation Serif', 'Liberation Mono'];
    }
    const currentFont = annotProps.fontFamily;
    if (currentFont) {
      ensureFontInStore(currentFont);
    }
    return systemFontList();
  });

  return (
    <Show when={sectionVis.textFormat}>
      <CollapsibleSection title={t('textFormat.title')} name="textFormat" id="prop-text-format-section">
        <Show when={annotProps.scannedTextEstimate === true}>
          <p class="scanned-text-estimate-note" role="note">
            Font class, size, weight, italic state, color, and alignment are estimates. The source font is not recovered exactly.
          </p>
        </Show>
        <ColorPalettePicker
          label={t('textFormat.textColor')}
          color={() => richValue('color', annotProps.textColor)}
          showNone={false}
          disabled={isLocked()}
          onColorChange={(color) => updateAnnotProp('textColor', color)}
        />

        <div class="property-group">
          <label>{t('textFormat.font')}</label>
          <select value={richFontFamily()} disabled={isLocked()}
            onDblClick={cycleSelectNext}
            onChange={(e) => updateAnnotProp('fontFamily', e.target.value)}>
            <Show when={richFontFamily() === 'mixed'}>
              <option value="mixed" disabled hidden>{tCommon('mixed')}</option>
            </Show>
            <For each={fonts()}>
              {(font) => <option value={font} style={{ 'font-family': `'${font}', sans-serif` }}>{font}</option>}
            </For>
          </select>
        </div>

        <div class="property-group">
          <label>{t('textFormat.fontSize')}</label>
          <PrefComboBox
            value={() => richValue('size', annotProps.textFontSize)}
            setValue={(val) => updateAnnotProp('textFontSize', val)}
            options={FONT_SIZE_OPTIONS}
            min={1} max={999} fallback={14} suffix="pt"
            disabled={isLocked}
          />
        </div>

        <div class="property-group">
          <label>{t('textFormat.style')}</label>
          <div class="text-style-buttons">
            <button type="button" class={`text-style-btn${richValue('bold', annotProps.fontBold) === true ? ' active' : ''}${richValue('bold', annotProps.fontBold) === 'mixed' ? ' mixed' : ''}`}
              title={t('textFormat.bold')} disabled={isLocked()}
              onClick={() => updateAnnotProp('fontBold', richValue('bold', annotProps.fontBold) === 'mixed' ? true : !richValue('bold', annotProps.fontBold))}>
              <strong>B</strong>
            </button>
            <button type="button" class={`text-style-btn${richValue('italic', annotProps.fontItalic) === true ? ' active' : ''}${richValue('italic', annotProps.fontItalic) === 'mixed' ? ' mixed' : ''}`}
              title={t('textFormat.italic')} disabled={isLocked()}
              onClick={() => updateAnnotProp('fontItalic', richValue('italic', annotProps.fontItalic) === 'mixed' ? true : !richValue('italic', annotProps.fontItalic))}>
              <em>I</em>
            </button>
            <Show when={annotProps.scannedTextEstimate !== true}>
              <button type="button" class={`text-style-btn${richValue('underline', annotProps.fontUnderline) === true ? ' active' : ''}${richValue('underline', annotProps.fontUnderline) === 'mixed' ? ' mixed' : ''}`}
                title={t('textFormat.underline')} disabled={isLocked()}
                onClick={() => updateAnnotProp('fontUnderline', richValue('underline', annotProps.fontUnderline) === 'mixed' ? true : !richValue('underline', annotProps.fontUnderline))}>
                <u>U</u>
              </button>
              <button type="button" class={`text-style-btn${richValue('strikeout', annotProps.fontStrikethrough) === true ? ' active' : ''}${richValue('strikeout', annotProps.fontStrikethrough) === 'mixed' ? ' mixed' : ''}`}
                title={t('textFormat.strikethrough')} disabled={isLocked()}
                onClick={() => updateAnnotProp('fontStrikethrough', richValue('strikeout', annotProps.fontStrikethrough) === 'mixed' ? true : !richValue('strikeout', annotProps.fontStrikethrough))}>
                <s>S</s>
              </button>
            </Show>
          </div>
        </div>

        {/* PDF text-edit mode: allow deleting the text edit that is open in the
            inline editor (inserted or existing PDF text). */}
        <Show when={panelMode() === 'textEdit'}>
          <div class="property-group">
            <button type="button" class="text-edit-delete-btn"
              onClick={() => import('../../../tools/text-edit-tool.js')
                .then(m => m.deleteActiveTextEdit && m.deleteActiveTextEdit())
                .catch(() => {})}>
              {tCommon('delete')}
            </button>
          </div>
        </Show>
      </CollapsibleSection>
    </Show>
  );
}

import { createEffect, createSignal, onCleanup } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { getActiveDocument } from '../../../core/state.js';

const SCOPE_KEYS = Object.freeze({
  annotation: 'scopeAnnotation',
  selection: 'scopeSelection',
  paragraph: 'scopeParagraph',
  findReplace: 'scopeFindReplace',
});

export default function FontSubstitutionDialog(props) {
  const { t } = useTranslation('hardening');
  const data = props.data || {};
  const [remember, setRemember] = createSignal(false);
  let settled = false;

  const finish = (approved, stale = false) => {
    if (settled) return;
    settled = true;
    closeDialog('font-substitution');
    data.resolve?.({ approved, remember: approved && remember(), stale });
  };

  const sources = () => Array.isArray(data.sourceFonts) ? data.sourceFonts : [];
  const scopeKey = () => SCOPE_KEYS[data.scope] || SCOPE_KEYS.paragraph;
  createEffect(() => {
    const active = getActiveDocument();
    if (!data.ownerDocumentId || active?.id !== data.ownerDocumentId
      || (Number(active?.lifecycleGeneration) || 0) !== Number(data.ownerDocumentGeneration)) {
      finish(false, true);
    }
  });
  onCleanup(() => {
    if (settled) return;
    settled = true;
    data.resolve?.({ approved: false, remember: false, stale: true });
  });
  const footer = (
    <div class="font-substitution-actions">
      <button type="button" class="pref-btn" onClick={() => finish(false)}>
        {t('fontSubstitution.cancel')}
      </button>
      <button type="button" class="pref-btn pref-btn-primary" onClick={() => finish(true)}>
        {t('fontSubstitution.approve')}
      </button>
    </div>
  );

  return (
    <Dialog
      title={t('fontSubstitution.title')}
      dialogClass="font-substitution-dialog"
      bodyClass="font-substitution-body"
      footerClass="font-substitution-footer"
      footer={footer}
      onClose={() => finish(false)}
      initialFocusSelector=".pref-btn-primary"
    >
      <dl class="font-substitution-details">
        <div>
          <dt>{t(sources().length === 1
            ? 'fontSubstitution.sourceFace'
            : 'fontSubstitution.sourceFaces')}</dt>
          <dd>{sources().join(', ') || t('fontSubstitution.unknown')}</dd>
        </div>
        <div>
          <dt>{t('fontSubstitution.packagedSubstitute')}</dt>
          <dd>{data.substituteFamily || t('fontSubstitution.notAvailable')}</dd>
        </div>
        <div>
          <dt>{t('fontSubstitution.scope')}</dt>
          <dd>{t(`fontSubstitution.${scopeKey()}`)}</dd>
        </div>
      </dl>
      <div class="font-substitution-sample-label">{t('fontSubstitution.sampleText')}</div>
      <div
        class="font-substitution-sample"
        style={{ 'font-family': data.substituteFamily || undefined }}
      >
        {data.sampleText || t('fontSubstitution.sampleFallback')}
      </div>
      <label class="font-substitution-remember">
        <input
          type="checkbox"
          checked={remember()}
          onChange={(event) => setRemember(event.currentTarget.checked)}
        />
        <span>{t('fontSubstitution.remember')}</span>
      </label>
    </Dialog>
  );
}

import Dialog from '../Dialog.jsx';
import { closeDialog } from '../../stores/dialogStore.js';

export default function UnsavedChangesDialog(props) {
  const data = props.data || {};

  const finish = (result) => {
    closeDialog('unsaved-changes');
    data.resolve?.(result);
  };

  return (
    <Dialog
      title={data.title || 'Save Changes'}
      dialogClass="unsaved-changes-dialog"
      role="alertdialog"
      onClose={() => finish('cancel')}
    >
      <div class="confirm-dialog-body">
        <div class="confirm-dialog-icon" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#e6a700" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <p class="confirm-dialog-message">{data.message || 'This document has unsaved changes.'}</p>
      </div>
      <div class="unsaved-changes-buttons">
        <button class="confirm-dialog-btn confirm-dialog-btn-save" onClick={() => finish('save')}>Save</button>
        <button class="confirm-dialog-btn confirm-dialog-btn-dont-save" onClick={() => finish('dontsave')}>Don't Save</button>
        <button class="confirm-dialog-btn confirm-dialog-btn-no" autofocus onClick={() => finish('cancel')}>Cancel</button>
      </div>
    </Dialog>
  );
}

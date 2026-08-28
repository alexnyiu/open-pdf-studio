import assert from 'node:assert/strict';

export const SAVE_CONTINUE_EDITING_SCENARIO = Object.freeze([
  'launch-packaged-app',
  'open-native-editable-pdf',
  'edit-a',
  'click-away-and-await-automatic-save',
  'assert-persisted-live-render-semantic-revisions-match',
  'manual-save-while-disk-clean',
  'edit-b-without-reopen',
  'save-again',
  'verify-both-edits-in-bytes-live-semantics-and-reopen',
]);

assert.fail(
  'F-01 acceptance is intentionally red until the packaged same-session save-and-continue workflow is implemented',
);

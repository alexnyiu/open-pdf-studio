import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTextApplyResult,
  textApplyResultCompletesInteraction,
  textApplyResultSchedulesPersistence,
} from './text-apply-result.js';
import { createTextEditSessionRegistry } from './text-edit-session-registry.js';

const context = Object.freeze({
  documentId: 'doc-a',
  documentGeneration: 4,
  pageNum: 2,
  contentRevision: 8,
  pageRevision: 8,
  editId: 'edit-1',
  editRevision: 3,
});

test('TextApplyResult is immutable and distinguishes no-op from persisted Apply', () => {
  const noop = createTextApplyResult({ status: 'noop', ...context });
  assert.deepEqual(noop, {
    status: 'noop', changed: false, ownerCommitted: false,
    visiblePublished: false, semanticPublished: false,
    documentId: 'doc-a', documentGeneration: 4, pageNum: 2,
    contentRevision: 8, pageRevision: 8, editId: 'edit-1', editRevision: 3,
    layoutAdjusted: false, layoutAdjustment: null, rejectionCode: null,
    recoveryActions: [], publicationError: null,
  });
  assert.equal(Object.isFrozen(noop), true);
  assert.equal(Object.isFrozen(noop.recoveryActions), true);
  assert.equal(textApplyResultCompletesInteraction(noop), true);
  assert.equal(textApplyResultSchedulesPersistence(noop), false);

  const applied = createTextApplyResult({
    status: 'applied', ...context,
    ownerCommitted: true,
    visiblePublished: true,
    semanticPublished: true,
    layoutAdjustment: {
      kind: 'auto-grow-width', deltaWidthPt: 0.05, deltaHeightPt: 0,
    },
  });
  assert.equal(applied.changed, true);
  assert.equal(applied.layoutAdjusted, true);
  assert.equal(textApplyResultCompletesInteraction(applied), true);
  assert.equal(textApplyResultSchedulesPersistence(applied), true);
});

test('structured rejected Apply retains the exact session and typed recovery actions', async () => {
  const owner = { id: 'doc-a', lifecycleGeneration: 4 };
  const registry = createTextEditSessionRegistry((id) => id === owner.id ? owner : null, {
    now: () => 1,
  });
  const rejected = createTextApplyResult({
    status: 'rejected', ...context,
    rejectionCode: 'TEXT_LAYOUT_COLUMN_BOUNDARY',
    recoveryActions: ['insert-line-break', 'keep-editing'],
  });
  const session = registry.register({
    ownerDocumentId: owner.id,
    ownerDocumentGeneration: owner.lifecycleGeneration,
    pageNum: 2,
    kind: 'owned-text',
    commit: () => rejected,
    cancel() {},
  });

  assert.equal(await registry.applyActive(), rejected);
  assert.equal(registry.active(), session);
});

test('structured no-op completes the session without masquerading as a mutation', async () => {
  const owner = { id: 'doc-a', lifecycleGeneration: 4 };
  const registry = createTextEditSessionRegistry((id) => id === owner.id ? owner : null, {
    now: () => 1,
  });
  const noop = createTextApplyResult({ status: 'noop', ...context });
  registry.register({
    ownerDocumentId: owner.id,
    ownerDocumentGeneration: owner.lifecycleGeneration,
    pageNum: 2,
    kind: 'native-source-text',
    commit: () => noop,
    cancel() {},
  });

  assert.equal(await registry.applyActive(), noop);
  assert.equal(registry.active(), null);
});

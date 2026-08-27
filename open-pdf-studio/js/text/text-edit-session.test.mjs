import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextEditSessionRegistry } from './text-edit-session-registry.js';
import {
  runOwnerScopedTextCommit,
  textEditValidationReason,
} from './text-edit-commit.js';

function fixture() {
  const documents = new Map([
    ['doc-a', { id: 'doc-a', lifecycleGeneration: 3 }],
    ['doc-b', { id: 'doc-b', lifecycleGeneration: 1 }],
  ]);
  return {
    documents,
    registry: createTextEditSessionRegistry((id) => documents.get(id) || null, { now: () => 1 }),
  };
}

test('coded validation failures retain their exact reason without classifying cancellation', () => {
  assert.equal(textEditValidationReason(Object.assign(
    new Error('An unbreakable word cannot remain inside the fixed region'),
    { code: 'REPLACEMENT_OVERFLOW' },
  )), 'An unbreakable word cannot remain inside the fixed region');
  assert.equal(textEditValidationReason({ code: 'MISSING_GLYPH' }), 'MISSING_GLYPH');
  assert.equal(textEditValidationReason(Object.assign(new Error('cancelled'), {
    code: 'SCANNED_TEXT_EDIT_OPERATION_INVALIDATED',
  })), null);
  assert.equal(textEditValidationReason(new Error('unexpected persistence failure')), null);
});

test('registration captures immutable owner, generation, page, and editor kind', () => {
  const { registry } = fixture();
  const session = registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 4,
    kind: 'ocr-reflow', commit() {}, cancel() {},
  });
  assert.equal(session.ownerDocumentId, 'doc-a');
  assert.equal(session.ownerDocumentGeneration, 3);
  assert.equal(session.pageNum, 4);
  assert.equal(session.kind, 'ocr-reflow');
  assert.equal(Object.isFrozen(session), true);
});

test('stale lifecycle rejects Apply and synchronously restores through cancel', async () => {
  const { registry, documents } = fixture();
  let commits = 0;
  const cancellations = [];
  registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 1,
    kind: 'native-source-text', commit() { commits += 1; }, cancel(reason) { cancellations.push(reason); },
  });
  documents.get('doc-a').lifecycleGeneration += 1;
  assert.equal(await registry.applyActive(), false);
  assert.equal(commits, 0);
  assert.deepEqual(cancellations, ['stale-owner']);
  assert.equal(registry.active(), null);
});

test('document cancellation targets only the immutable owner', () => {
  const { registry } = fixture();
  const reasons = [];
  registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 1,
    kind: 'textbox', commit() {}, cancel(reason) { reasons.push(reason); },
  });
  assert.equal(registry.cancelForDocument('doc-b', 'tab-switch'), false);
  assert.ok(registry.active());
  assert.equal(registry.cancelForDocument('doc-a', 'tab-switch'), true);
  assert.deepEqual(reasons, ['tab-switch']);
});

test('dirty-state lookup is owner scoped and fails safe when the editor cannot report', () => {
  const { registry } = fixture();
  let dirty = false;
  registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 1,
    kind: 'native-source-text', isDirty: () => dirty, commit() {}, cancel() {},
  });
  assert.equal(registry.isDirtyForDocument('doc-b'), false);
  assert.equal(registry.isDirtyForDocument('doc-a'), false);
  dirty = true;
  assert.equal(registry.isDirtyForDocument('doc-a'), true);

  registry.register({
    ownerDocumentId: 'doc-b', ownerDocumentGeneration: 1, pageNum: 1,
    kind: 'textbox', isDirty() { throw new Error('draft probe failed'); }, commit() {}, cancel() {},
  });
  assert.equal(registry.isDirtyForDocument('doc-b'), true);
});

test('superseding a session cancels the prior draft before registering the next', () => {
  const { registry } = fixture();
  const reasons = [];
  registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 1,
    kind: 'inserted-text', commit() {}, cancel(reason) { reasons.push(reason); },
  });
  const next = registry.register({
    ownerDocumentId: 'doc-b', ownerDocumentGeneration: 1, pageNum: 2,
    kind: 'callout', commit() {}, cancel() {},
  });
  assert.deepEqual(reasons, ['superseded']);
  assert.equal(registry.active(), next);
});

test('cancelling an in-flight Apply invalidates its token and preserves a newer session', async () => {
  const { registry } = fixture();
  let releaseCommit;
  let operation = null;
  let ownerMutations = 0;
  const cancellations = [];
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 1,
    kind: 'ocr-one-line',
    async commit(token) {
      operation = token;
      await commitGate;
      if (!token.isCurrent()) return false;
      ownerMutations += 1;
      return true;
    },
    cancel(reason) { cancellations.push(reason); },
  });

  const applying = registry.applyActive();
  await Promise.resolve();
  assert.ok(operation);
  assert.equal(operation.isCurrent(), true);
  assert.equal(registry.cancelForDocument('doc-a', 'tab-switch'), true);
  assert.equal(operation.isCurrent(), false);

  const newer = registry.register({
    ownerDocumentId: 'doc-b', ownerDocumentGeneration: 1, pageNum: 2,
    kind: 'ocr-reflow', commit() {}, cancel() {},
  });
  releaseCommit();

  assert.equal(await applying, false);
  assert.equal(ownerMutations, 0);
  assert.deepEqual(cancellations, ['tab-switch']);
  assert.equal(registry.active(), newer);
});

test('lifecycle replacement during Apply invalidates the token and cancels the source session', async () => {
  const { registry, documents } = fixture();
  let releaseCommit;
  let operation = null;
  let ownerMutations = 0;
  const cancellations = [];
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 1,
    kind: 'ocr-fixed-multiline',
    async commit(token) {
      operation = token;
      await commitGate;
      if (!token.isCurrent()) return false;
      ownerMutations += 1;
      return true;
    },
    cancel(reason) { cancellations.push(reason); },
  });

  const applying = registry.applyActive();
  await Promise.resolve();
  documents.get('doc-a').lifecycleGeneration += 1;
  assert.equal(operation.isCurrent(), false);
  releaseCommit();

  assert.equal(await applying, false);
  assert.equal(ownerMutations, 0);
  assert.deepEqual(cancellations, ['stale-owner']);
  assert.equal(registry.active(), null);
});

test('rejected and thrown Apply attempts keep the same session retryable', async () => {
  const { registry } = fixture();
  let attempts = 0;
  const session = registry.register({
    ownerDocumentId: 'doc-a', ownerDocumentGeneration: 3, pageNum: 1,
    kind: 'owned-text',
    commit() {
      attempts += 1;
      if (attempts === 1) return false;
      if (attempts === 2) throw new Error('persistence unavailable');
      return true;
    },
    cancel() { throw new Error('failed Apply must not cancel the live draft'); },
  });

  assert.equal(await registry.applyActive(), false);
  assert.equal(registry.active(), session);
  await assert.rejects(registry.applyActive(), /persistence unavailable/u);
  assert.equal(registry.active(), session);
  assert.equal(await registry.applyActive(), true);
  assert.equal(registry.active(), null);
});

test('owner-scoped commit rejection or throw restores owner history and content', () => {
  const ownerDocument = {
    id: 'doc-a',
    records: [{ id: 'before' }],
    undoStack: [{ type: 'before' }],
    redoStack: [{ type: 'redo-before' }],
    savedUndoStackLength: 1,
    modified: false,
  };
  const originalUndo = ownerDocument.undoStack;
  const originalRedo = ownerDocument.redoStack;
  const attempt = (outcome) => runOwnerScopedTextCommit({
    ownerDocument,
    attempt() {
      ownerDocument.records.push({ id: 'draft' });
      ownerDocument.undoStack.push({ type: 'draft' });
      ownerDocument.redoStack = [];
      ownerDocument.savedUndoStackLength = -1;
      ownerDocument.modified = true;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    rollback() {
      ownerDocument.records = ownerDocument.records.filter(({ id }) => id !== 'draft');
    },
  });

  assert.equal(attempt(false), false);
  assert.deepEqual(ownerDocument.records, [{ id: 'before' }]);
  assert.equal(ownerDocument.undoStack, originalUndo);
  assert.equal(ownerDocument.redoStack, originalRedo);
  assert.deepEqual(ownerDocument.undoStack, [{ type: 'before' }]);
  assert.deepEqual(ownerDocument.redoStack, [{ type: 'redo-before' }]);
  assert.equal(ownerDocument.savedUndoStackLength, 1);
  assert.equal(ownerDocument.modified, false);

  assert.throws(() => attempt(new Error('recording failed')), /recording failed/u);
  assert.deepEqual(ownerDocument.records, [{ id: 'before' }]);
  assert.deepEqual(ownerDocument.undoStack, [{ type: 'before' }]);
  assert.deepEqual(ownerDocument.redoStack, [{ type: 'redo-before' }]);
  assert.equal(ownerDocument.savedUndoStackLength, 1);
  assert.equal(ownerDocument.modified, false);
});

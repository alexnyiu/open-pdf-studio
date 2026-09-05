import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPageTextSurface } from './page-surface-ready.js';
import { markPageSurfacePublication, registerPageSurface, clearPageSurfaceRegistryForTests } from './page-surface-registry.js';
const element = () => ({ isConnected: true, dataset: {} });
test.beforeEach(clearPageSurfaceRegistryForTests);
test('distant navigation waits for its own mounted text surface', async () => {
  const doc = { id: 'a', lifecycleGeneration: 1, revisionState: { contentRevision: 0 } };
  let settled = false;
  const ready = waitForPageTextSurface(doc, 499).then(surface => { settled = true; return surface; });
  registerPageSurface({ documentState: doc, pageNum: 250, container: element(), baseSurface: element(), textLayer: element() });
  await Promise.resolve(); assert.equal(settled, false);
  registerPageSurface({ documentState: doc, pageNum: 499, container: element(), baseSurface: element(), textLayer: element() });
  assert.equal((await ready).pageNum, 499);
});
test('a superseded navigation releases its listener and rejects', async () => {
  const controller = new AbortController();
  const ready = waitForPageTextSurface({ id: 'a' }, 499, { signal: controller.signal });
  controller.abort(); await assert.rejects(ready, { name: 'AbortError' });
});

test('connected stale raster or semantic publication cannot satisfy a revised search', async () => {
  const doc = { id: 'a', lifecycleGeneration: 1, revisionState: { contentRevision: 3, pageContentRevisions: { 499: 2 } } };
  const surface = registerPageSurface({ documentState: doc, pageNum: 499,
    container: element(), baseSurface: element(), textLayer: element(),
    pageContentRevision: 1, basePublishedRevision: 1, semanticPublishedRevision: 1 });
  let settled = false;
  const ready = waitForPageTextSurface(doc, 499).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  markPageSurfacePublication(surface, { documentState: doc, revision: 2, basePublished: true });
  await Promise.resolve(); assert.equal(settled, false, 'text must also match the target page revision');
  markPageSurfacePublication(surface, { documentState: doc, revision: 2, semanticPublished: true });
  assert.equal((await ready).semanticPublishedRevision, 2);
});

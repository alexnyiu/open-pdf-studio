import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContinuousRasterImage } from './continuous-raster-image.js';
import { createRenderWorkScheduler } from './render-work-scheduler.js';

function pendingImage() {
  return {
    naturalWidth: 0,
    naturalHeight: 0,
    onload: null,
    onerror: null,
    removedSource: false,
    removeAttribute(name) {
      if (name === 'src') this.removedSource = true;
    },
    set src(value) { this.source = value; },
    get src() { return this.source; },
  };
}

test('a loaded image is not publishable until decoding completes', async () => {
  const image = pendingImage();
  image.naturalWidth = 100;
  image.naturalHeight = 50;
  let decoded;
  image.decode = () => new Promise((resolve) => { decoded = resolve; });
  let published = false;
  const loaded = loadContinuousRasterImage({ url: 'local-raster', width: 100, height: 50, attach: () => true }, {
    createImage: () => image,
  }).then((value) => { published = true; return value; });
  const loading = image.onload();
  await Promise.resolve();
  assert.equal(published, false);
  decoded();
  await loading;
  assert.equal(await loaded, image);
});

test('owner cancellation during decode cannot publish a late sharp image', async () => {
  const controller = new AbortController();
  const image = pendingImage();
  let decoded;
  image.decode = () => new Promise((resolve) => { decoded = resolve; });
  const loaded = loadContinuousRasterImage({ url: 'local-raster', width: 100, height: 50, attach: () => true }, {
    createImage: () => image, signal: controller.signal,
  });
  const rejected = assert.rejects(loaded, { name: 'AbortError' });
  const loading = image.onload();
  controller.abort();
  decoded();
  await Promise.all([loading, rejected]);
  assert.equal(image.removedSource, true);
});

test('aborting a pending direct raster image settles its load promise', async () => {
  const controller = new AbortController();
  const image = pendingImage();
  const lease = {
    url: 'http://127.0.0.1:1234/render',
    width: 100,
    height: 50,
    attach(candidate) {
      assert.equal(candidate, image);
      return true;
    },
  };

  const loaded = loadContinuousRasterImage(lease, {
    signal: controller.signal,
    createImage: () => image,
  });
  controller.abort('owner-cancelled');

  await assert.rejects(loaded, (error) => error?.name === 'AbortError');
  assert.equal(image.removedSource, true);
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
});

test('abort-aware raster loads release retired work and unblock the winning render', async () => {
  const scheduler = createRenderWorkScheduler({ maxRetiredPerOwner: 2 });
  const ownerKey = 'large-document:1';
  const retire = async (key) => {
    const result = scheduler.schedule({
      key,
      ownerKey,
      run: ({ signal }) => loadContinuousRasterImage({
        url: `http://127.0.0.1:1234/${key}`,
        width: 100,
        height: 50,
        attach: () => true,
      }, {
        signal,
        createImage: pendingImage,
      }),
    });
    scheduler.cancelOwner(ownerKey, 'fling-reprioritized');
    assert.equal((await result).status, 'cancelled');
  };

  await retire('page-49');
  await retire('page-40');
  await Promise.resolve();
  await Promise.resolve();

  const winning = scheduler.schedule({
    key: 'page-1',
    ownerKey,
    run: () => 'current pixels',
  });
  assert.deepEqual(await winning, { status: 'complete', value: 'current pixels' });
  assert.equal(scheduler.snapshot().retired.length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

class MockWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
    MockWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, data) {
    this.listeners.get(type)?.({ data, message: data?.message });
  }
}

test('superseding exact layout cooperatively cancels and preserves the Worker cache', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = MockWorker;
  MockWorker.instances = [];
  try {
    const scheduler = await import(`./native-layout-scheduler.js?supersede=${Date.now()}`);
    const first = scheduler.requestLatestNativeLayout({ lines: [] }, {}, 'first');
    const firstWorker = MockWorker.instances[0];
    const firstRequestId = firstWorker.messages[0].requestId;

    const second = scheduler.requestLatestNativeLayout({ lines: [] }, {}, 'second');
    const secondWorker = MockWorker.instances[0];
    const secondRequestId = secondWorker.messages.at(-1).requestId;

    await assert.rejects(first, (error) => error?.code === 'TEXT_LAYOUT_CANCELLED');
    assert.equal(firstWorker.terminated, false);
    assert.equal(secondWorker, firstWorker);
    assert.deepEqual(firstWorker.messages.map((message) => message.type), ['layout', 'cancel', 'layout']);
    assert.equal(secondWorker.terminated, false);
    assert.deepEqual(scheduler.exactLayoutSchedulerState(), {
      activeTasks: 1,
      requestId: secondRequestId,
    });

    firstWorker.emit('message', { type: 'cancelled', requestId: firstRequestId });
    assert.equal(scheduler.exactLayoutSchedulerState().requestId, secondRequestId);

    secondWorker.emit('message', {
      type: 'result', requestId: secondRequestId, fingerprint: 'second', result: { valid: true },
    });
    assert.deepEqual(await second, { fingerprint: 'second', result: { valid: true } });
    assert.deepEqual(scheduler.exactLayoutSchedulerState(), { activeTasks: 0, requestId: null });
    assert.equal(secondWorker.terminated, false, 'completed Worker should retain its local cache');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('explicit cancellation keeps a responsive Worker warm', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = MockWorker;
  MockWorker.instances = [];
  try {
    const scheduler = await import(`./native-layout-scheduler.js?cancel=${Date.now()}`);
    const pending = scheduler.requestLatestNativeLayout({ lines: [] }, {}, 'pending');
    const activeWorker = MockWorker.instances[0];

    assert.equal(scheduler.cancelLatestNativeLayout(), true);
    await assert.rejects(pending, (error) => error?.code === 'TEXT_LAYOUT_CANCELLED');
    assert.deepEqual(activeWorker.messages.map((message) => message.type), ['layout', 'cancel']);
    activeWorker.emit('message', {
      type: 'cancelled', requestId: activeWorker.messages[0].requestId,
    });
    assert.equal(activeWorker.terminated, false);
    assert.deepEqual(scheduler.exactLayoutSchedulerState(), { activeTasks: 0, requestId: null });
    assert.equal(scheduler.cancelLatestNativeLayout(), false);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('an unresponsive cancelled task hard-restarts and replays only the latest request', async () => {
  const originalWorker = globalThis.Worker;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let timerId = 0;
  globalThis.Worker = MockWorker;
  globalThis.setTimeout = (callback) => {
    const id = ++timerId;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  MockWorker.instances = [];
  try {
    const scheduler = await import(`./native-layout-scheduler.js?fallback=${Date.now()}`);
    const first = scheduler.requestLatestNativeLayout({ lines: [] }, {}, 'first');
    const firstWorker = MockWorker.instances[0];
    const second = scheduler.requestLatestNativeLayout({ lines: [] }, {}, 'second');
    await assert.rejects(first, (error) => error?.code === 'TEXT_LAYOUT_CANCELLED');
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    const replacement = MockWorker.instances[1];
    assert.equal(firstWorker.terminated, true);
    assert.ok(replacement);
    assert.deepEqual(replacement.messages.map((message) => message.fingerprint), ['second']);
    const secondMessage = replacement.messages[0];
    replacement.emit('message', {
      type: 'result', requestId: secondMessage.requestId,
      fingerprint: 'second', result: { valid: true },
    });
    assert.deepEqual(await second, { fingerprint: 'second', result: { valid: true } });
  } finally {
    globalThis.Worker = originalWorker;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

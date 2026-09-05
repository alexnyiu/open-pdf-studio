import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemandFrameLoop } from './demand-frame-loop.js';
test('clean and inactive viewports stop scheduling; dirty and momentum resume once', () => {
  let active = true, dirty = true, renders = 0, next = 0;
  const frames = new Map();
  const loop = createDemandFrameLoop({ requestFrame: fn => { frames.set(++next, fn); return next; }, cancelFrame: id => frames.delete(id),
    active: () => active, dirty: () => dirty, render: () => { renders++; dirty = false; } });
  const tick = () => { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(); };
  loop.wake(); loop.wake(); assert.equal(frames.size, 1); tick();
  assert.equal(renders, 1); assert.equal(frames.size, 0);
  active = false; dirty = true; loop.wake(); assert.equal(frames.size, 0);
  active = true; loop.wake(); assert.equal(frames.size, 1); loop.stop(); assert.equal(frames.size, 0);
  loop.wake(); tick(); assert.equal(renders, 2);
});

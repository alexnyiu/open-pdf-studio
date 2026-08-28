import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('MCP click hit-tests again after hover-driven layer routing', async () => {
  const source = await readFile(new URL('./mcp-bridge.js', import.meta.url), 'utf8');
  const clickStart = source.indexOf('async function handleMouseClick');
  const clickEnd = source.indexOf('async function handleMouseDrag', clickStart);
  const handler = source.slice(clickStart, clickEnd);
  const moveDispatch = handler.indexOf("dispatchPointerAndMouse(moveTarget, 'move'");
  const pressRetarget = handler.indexOf('const target = targetAt(x, y)', moveDispatch);
  const downDispatch = handler.indexOf("dispatchPointerAndMouse(target, 'down'", pressRetarget);

  assert.ok(moveDispatch >= 0, 'click must first dispatch a production hover move');
  assert.ok(pressRetarget > moveDispatch, 'click must hit-test after hover routing changes');
  assert.ok(downDispatch > pressRetarget, 'pointerdown must use the post-hover target');
});

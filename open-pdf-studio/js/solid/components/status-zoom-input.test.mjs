import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('status zoom keeps a local draft while the input owns focus', async () => {
  const source = await readFile(new URL('./StatusBar.jsx', import.meta.url), 'utf8');

  assert.match(source, /const \[zoomDraft, setZoomDraft\] = createSignal\(zoomText\(\)\)/u);
  assert.match(source, /if \(!zoomInputFocused\(\)\) setZoomDraft\(canonical\)/u);
  assert.match(source, /onInput=\{\(event\) => setZoomDraft\(event\.currentTarget\.value\)\}/u);
  assert.match(source, /onBlur=\{handleZoomDraftBlur\}/u);
  assert.doesNotMatch(source, /class="status-zoom-input"[^>]*value=\{zoomText\(\)\}/u);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOcrProcessAttribution,
  updateMacOcrProcessAttribution,
} from './ocr-process-attribution.mjs';

const webKit = (pid) => ({
  pid,
  ppid: 1,
  command: '/System/Library/Frameworks/WebKit.framework/com.apple.WebKit.WebContent',
});

test('macOS attribution excludes baseline WebKit and captures a live OCR child cohort', () => {
  const attribution = createOcrProcessAttribution();
  updateMacOcrProcessAttribution(attribution, [webKit(101), webKit(102)], []);
  updateMacOcrProcessAttribution(
    attribution,
    [webKit(101), webKit(102), webKit(203), webKit(204)],
    [{ pid: 200 }],
  );

  assert.deepEqual([...attribution.baselineWebKitPids], [101, 102]);
  assert.deepEqual([...attribution.childPids], [200]);
  assert.deepEqual([...attribution.childWebKitPids], [203, 204]);
});

test('macOS attribution cannot attach a later XPC process to an exited OCR child', () => {
  const attribution = createOcrProcessAttribution();
  updateMacOcrProcessAttribution(attribution, [webKit(101)], []);
  updateMacOcrProcessAttribution(attribution, [webKit(101), webKit(203)], [{ pid: 200 }]);
  updateMacOcrProcessAttribution(attribution, [webKit(101), webKit(203), webKit(250)], []);

  assert.deepEqual([...attribution.childWebKitPids], [203]);
});

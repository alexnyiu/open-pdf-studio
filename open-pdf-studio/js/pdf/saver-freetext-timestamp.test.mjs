import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const saverSource = await readFile(new URL('./saver.js', import.meta.url), 'utf8');
const helperStart = saverSource.indexOf('function stableFreeTextModifiedTimestamp(');
const helperEnd = saverSource.indexOf('\n}\n', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'FreeText timestamp helper is missing');
const helperSource = saverSource.slice(helperStart, helperEnd + 2);
const stableFreeTextModifiedTimestamp = Function(
  `'use strict'; ${helperSource}; return stableFreeTextModifiedTimestamp;`,
)();

test('FreeText timestamp preserves modification priority and canonical instant', () => {
  assert.equal(stableFreeTextModifiedTimestamp({
    modifiedAt: '2026-08-26T19:20:21.456-07:00',
    createdAt: '2020-01-01T00:00:00.000Z',
  }), '2026-08-27T02:20:21.456Z');
});

test('FreeText timestamp falls back through persisted and creation fields', () => {
  assert.equal(stableFreeTextModifiedTimestamp({
    modifiedAt: 'invalid',
    modificationDate: '2024-02-03T04:05:06.007Z',
    createdAt: '2020-01-01T00:00:00.000Z',
  }), '2024-02-03T04:05:06.007Z');
  assert.equal(stableFreeTextModifiedTimestamp({
    createdAt: new Date('2023-04-05T06:07:08.009Z'),
  }), '2023-04-05T06:07:08.009Z');
  assert.equal(stableFreeTextModifiedTimestamp({
    creationDate: '2022-03-04T05:06:07Z',
  }), '2022-03-04T05:06:07.000Z');
});

test('FreeText timestamp has a clock-independent unknown fallback', () => {
  const first = stableFreeTextModifiedTimestamp({});
  const second = stableFreeTextModifiedTimestamp({ modifiedAt: 'not a date' });
  assert.equal(first, '1970-01-01T00:00:00.000Z');
  assert.equal(second, first);
});

test('FreeText serializer uses the stable timestamp rather than the save clock', () => {
  const caseStart = saverSource.indexOf("case 'text':");
  const caseEnd = saverSource.indexOf("case 'image':", caseStart);
  const freeTextCase = saverSource.slice(caseStart, caseEnd);
  assert.match(
    freeTextCase,
    /M:\s*PDFString\.of\(stableFreeTextModifiedTimestamp\(ann\)\)/u,
  );
});

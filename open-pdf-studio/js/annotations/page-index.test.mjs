import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationsForPage } from './page-index.js';
test('same-length documents have independent page indexes and preserve draw order', () => {
  const a={annotations:[{id:'a',page:2},{id:'b',page:1},{id:'c',page:2}]};
  const b={annotations:[{id:'d',page:1},{id:'e',page:1},{id:'f',page:1}]};
  assert.deepEqual(annotationsForPage(a,2).map(x=>x.id),['a','c']);
  assert.equal(annotationsForPage(b,2).length,0);
  assert.equal(annotationsForPage(a,2),annotationsForPage(a,2));
});
test('insert, replace, reorder, and page movement invalidate membership while geometry stays live', () => {
  const doc={annotations:[{id:'a',page:1,x:0},{id:'b',page:1}],revisionState:{contentRevision:0}};
  const page=annotationsForPage(doc,1);doc.annotations[0].x=50;
  assert.equal(page[0].x,50);
  doc.annotations.push({id:'c',page:2});assert.equal(annotationsForPage(doc,2)[0].id,'c');
  doc.annotations.reverse();doc.annotations[1].page=2;doc.revisionState.contentRevision++;
  assert.deepEqual(annotationsForPage(doc,2).map(x=>x.id),['c','b']);
  doc.annotations=[{id:'new',page:3}];assert.equal(annotationsForPage(doc,1).length,0);
});

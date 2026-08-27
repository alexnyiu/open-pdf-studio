import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('a late tool-default fallback cannot erase an active text editor properties panel', async () => {
  const source = await readFile(new URL('./manager.js', import.meta.url), 'utf8');
  const defaultsBlock = source.slice(
    source.indexOf('// When switching to a drawing tool that has style preferences'),
    source.indexOf('// Tear down select fall-through'),
  );

  assert.match(
    source,
    /import \{ getActiveTextEditSession \} from '\.\.\/text\/text-edit-session\.js';/u,
  );
  assert.match(
    defaultsBlock,
    /if \(isCurrentDefaultsRequest\(\) && !getActiveTextEditSession\(\)\) hideProperties\(\);/u,
    'the asynchronous fallback must preserve the panel once an editor session owns it',
  );
});

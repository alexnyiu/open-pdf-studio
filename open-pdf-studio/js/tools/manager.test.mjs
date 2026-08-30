import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { textEditDeactivationOwnsSession } from '../text/text-edit-deactivation.js';

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

test('a delayed text-tool deactivation retains the session it is allowed to cancel', async () => {
  const [manager, textTool] = await Promise.all([
    readFile(new URL('./manager.js', import.meta.url), 'utf8'),
    readFile(new URL('./text-edit-tool.js', import.meta.url), 'utf8'),
  ]);
  const deactivation = manager.slice(
    manager.indexOf('// Deactivate PDF text editing when switching away'),
    manager.indexOf('const owner = getActiveDocument();'),
  );
  assert.match(
    deactivation,
    /textEditSessionAtDeactivation = getActiveTextEditSession\(\)\?\.sessionId \?\? null/u,
  );
  assert.match(
    deactivation,
    /deactivateEditTextTool\(textEditSessionAtDeactivation\)/u,
  );
  assert.match(
    textTool,
    /const ownsActiveSession = textEditDeactivationOwnsSession\([\s\S]*if \(ownsActiveSession\) \{[\s\S]*cancelActiveTextEditing\('tool-deactivated'\)[\s\S]*if \(!ownsActiveSession\) return 'superseded';[\s\S]*state\.isEditingPdfText = false/u,
  );
  assert.equal(textEditDeactivationOwnsSession('editor-a', 'editor-a'), true);
  assert.equal(textEditDeactivationOwnsSession('editor-b', 'editor-a'), false);
  assert.equal(textEditDeactivationOwnsSession('editor-b', null), false);
  assert.equal(textEditDeactivationOwnsSession(null, null), true);
  assert.equal(textEditDeactivationOwnsSession('editor-b', undefined), true);
});

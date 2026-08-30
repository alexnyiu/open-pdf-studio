import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { awaitPackagedReadiness, callMcpRpc } from './macos-packaged-app.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('packaged launch reports an exit before MCP with the actual signal', async () => {
  const result = await awaitPackagedReadiness({
    initialize: () => new Promise(() => {}),
    launchOutcome: Promise.resolve({ kind: 'exit', code: null, signal: 'SIGABRT' }),
    timeoutMs: 100,
    pollIntervalMs: 5,
  });
  assert.deepEqual(result, {
    status: 'exited',
    stage: 'before-mcp',
    code: null,
    signal: 'SIGABRT',
    lastInitializationError: null,
  });
});

test('packaged launch distinguishes exit after MCP from WebView readiness', async () => {
  const launcher = deferred();
  let attempts = 0;
  const result = await awaitPackagedReadiness({
    initialize: async () => {
      attempts += 1;
      if (attempts === 1) {
        setTimeout(() => launcher.resolve({ kind: 'exit', code: 70, signal: null }), 0);
      }
      return { _meta: { openPdfStudio: { webviewReady: false } } };
    },
    launchOutcome: launcher.promise,
    timeoutMs: 100,
    pollIntervalMs: 5,
  });
  assert.equal(result.status, 'exited');
  assert.equal(result.stage, 'before-webview');
  assert.equal(result.code, 70);
  assert.equal(result.signal, null);
});

test('packaged launch timeout retains its terminal stage and last MCP error', async () => {
  const result = await awaitPackagedReadiness({
    initialize: async () => { throw new Error('connection refused'); },
    launchOutcome: new Promise(() => {}),
    timeoutMs: 15,
    pollIntervalMs: 2,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.stage, 'before-mcp');
  assert.equal(result.lastInitializationError, 'connection refused');
});

test('packaged launch succeeds only after WebView readiness', async () => {
  const initialized = {
    _meta: { openPdfStudio: { webviewReady: true, processId: 1234 } },
  };
  const result = await awaitPackagedReadiness({
    initialize: async () => initialized,
    launchOutcome: new Promise(() => {}),
    timeoutMs: 100,
    pollIntervalMs: 5,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.stage, 'webview-ready');
  assert.equal(result.initialized, initialized);
});

test('runtime MCP calls use an independent bounded timeout', async (context) => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    }, 25);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  await assert.rejects(
    callMcpRpc(endpoint, 1, 'tools/call', {}, { timeoutMs: 5 }),
    (error) => error.code === 'MCP_RPC_TIMEOUT'
      && error.method === 'tools/call'
      && error.timeoutMs === 5,
  );
  assert.deepEqual(
    await callMcpRpc(endpoint, 2, 'tools/call', {}, { timeoutMs: 100 }),
    { ok: true },
  );
});

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  assertEqual,
  CdpClient,
  debuggerTargetUrl,
  fatalCdpEvents,
  keyChord,
  keyDispatchParams,
  parseDebuggerTargetPayload,
  waitForCondition,
} from './cdp-client.mjs';

test('CDP resumes a debugger-paused page before enabling domains', async () => {
  const messages = [];

  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      assert.equal(url, 'ws://127.0.0.1:9222/devtools/page/target');
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    send(payload) {
      const message = JSON.parse(payload);
      messages.push(message);
      queueMicrotask(() => {
        const event = new Event('message');
        Object.defineProperty(event, 'data', {
          value: JSON.stringify({ id: message.id, result: {} }),
        });
        this.dispatchEvent(event);
      });
    }
  }

  await new CdpClient('ws://127.0.0.1:9222/devtools/page/target', {
    WebSocketImpl: FakeWebSocket,
  }).connect();

  assert.deepEqual(messages, [
    { id: 1, method: 'Runtime.runIfWaitingForDebugger', params: {} },
    { id: 2, method: 'Runtime.enable', params: {} },
    { id: 3, method: 'Page.enable', params: {} },
    { id: 4, method: 'Log.enable', params: {} },
  ]);
});

test('waitForCondition resolves once a condition becomes true', async () => {
  let attempts = 0;
  assert.equal(await waitForCondition(() => ++attempts === 2, { intervalMs: 1 }), true);
});

test('waitForCondition reports a missing required selector/condition', async () => {
  await assert.rejects(
    () =>
      waitForCondition(() => false, {
        timeoutMs: 5,
        intervalMs: 1,
        description: 'selector [data-e2e=missing]',
      }),
    /selector \[data-e2e=missing\]/
  );
});

test('assertEqual reports expected and received values', () => {
  assert.throws(() => assertEqual('one', 'two', 'filename'), /expected.*received/);
});

test('key dispatch includes Windows virtual key codes and modifiers', () => {
  assert.deepEqual(keyDispatchParams(',', 'keyDown', 2), {
    type: 'keyDown',
    key: ',',
    code: 'Comma',
    windowsVirtualKeyCode: 188,
    nativeVirtualKeyCode: 188,
    modifiers: 2,
  });
});

test('arrow keys use DOM codes and Windows virtual key codes', () => {
  assert.equal(keyDispatchParams('ArrowLeft', 'keyDown').code, 'ArrowLeft');
  assert.equal(keyDispatchParams('ArrowLeft', 'keyDown').windowsVirtualKeyCode, 37);
  assert.equal(keyDispatchParams('ArrowRight', 'keyDown').windowsVirtualKeyCode, 39);
});

test('keyChord dispatches key events through the supplied client', async () => {
  const command = async () => undefined;
  const client = { command: mock.fn(command) };
  await keyChord(client, ['Control', 'k']);
  assert.equal(client.command.mock.callCount(), 4);
  assert.deepEqual(
    client.command.mock.calls[0].arguments[1],
    keyDispatchParams('Control', 'keyDown')
  );
});

test('fatalCdpEvents excludes informational console events', () => {
  assert.equal(
    fatalCdpEvents({
      console: [{ type: 'info' }, { type: 'warning' }, { type: 'error' }],
      exceptions: [],
    }).length,
    1
  );
});

test('parses a debugger pipe target payload', () => {
  assert.deepEqual(
    parseDebuggerTargetPayload(
      '[{"id":"target","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/page/1"}]'
    ),
    { id: 'target', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' }
  );
  assert.equal(
    debuggerTargetUrl({ id: 'target', type: 'page' }, 9222),
    'ws://127.0.0.1:9222/devtools/page/target'
  );
  assert.throws(() => parseDebuggerTargetPayload('{}'), /webSocketDebuggerUrl/);
  assert.throws(() => debuggerTargetUrl({ id: '', type: 'page' }, 9222), /non-empty id/);
});

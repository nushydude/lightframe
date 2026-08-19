import { createServer } from 'node:net';

export function parseDebuggerTargetPayload(payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const targets = Array.isArray(parsed) ? parsed : [parsed];
  const target = targets.find(
    (candidate) =>
      typeof candidate?.webSocketDebuggerUrl === 'string' ||
      (candidate?.type === 'page' && typeof candidate?.id === 'string')
  );
  if (!target)
    throw new Error(
      `Debugger pipe payload did not contain webSocketDebuggerUrl: ${JSON.stringify(parsed)}`
    );
  return target;
}

export function debuggerTargetUrl(target, port) {
  if (typeof target?.webSocketDebuggerUrl === 'string') return target.webSocketDebuggerUrl;
  if (target?.type !== 'page' || typeof target?.id !== 'string' || !target.id) {
    throw new Error('Debugger pipe target must identify a page with a non-empty id');
  }
  return `ws://127.0.0.1:${port}/devtools/page/${target.id}`;
}

export async function createDebuggerPipeServer(appName, pipeName) {
  const path = `\\\\.\\pipe\\WebView2\\Debugger\\${appName}\\${pipeName}`;
  let resolveTarget;
  let rejectTarget;
  const target = new Promise((resolve, reject) => {
    resolveTarget = resolve;
    rejectTarget = reject;
  });
  const server = createServer((socket) => {
    let payload = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      payload += chunk;
      try {
        resolveTarget(parseDebuggerTargetPayload(payload));
        socket.end();
      } catch {
        // The pipe may split its JSON payload over several chunks.
      }
    });
    socket.once('error', rejectTarget);
    socket.once('end', () => {
      try {
        resolveTarget(parseDebuggerTargetPayload(payload));
      } catch (error) {
        rejectTarget(error);
      }
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve));
  return {
    path,
    target,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve)
  );
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function waitForCondition(
  condition,
  { timeoutMs = 10_000, intervalMs = 100, description = 'condition' } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`
  );
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
}

function isKnownLegacyAssetSchemeWarning(event) {
  if (
    event.source !== 'network' ||
    event.level !== 'error' ||
    event.text !== 'Failed to load resource: net::ERR_UNKNOWN_URL_SCHEME' ||
    typeof event.url !== 'string'
  ) {
    return false;
  }

  try {
    return new URL(event.url).protocol === 'lightframe-asset:';
  } catch {
    return false;
  }
}

export function fatalCdpEvents(events) {
  return [
    ...events.exceptions,
    ...events.console.filter(
      (event) =>
        ['error', 'assert'].includes(event.type ?? event.level) &&
        !isKnownLegacyAssetSchemeWarning(event)
    ),
  ];
}

const keyInfo = {
  Control: ['Control', 'ControlLeft', 17, 2],
  Meta: ['Meta', 'MetaLeft', 91, 4],
  Alt: ['Alt', 'AltLeft', 18, 1],
  Shift: ['Shift', 'ShiftLeft', 16, 8],
  Escape: ['Escape', 'Escape', 27, 0],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37, 0],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39, 0],
  ',': [',', 'Comma', 188, 0],
};
export function keyDispatchParams(key, type, modifiers = 0) {
  const [value, code, windowsVirtualKeyCode, ownModifier] = keyInfo[key] ?? [
    key,
    `Key${key.toUpperCase()}`,
    key.toUpperCase().charCodeAt(0),
    0,
  ];
  return {
    type,
    key: value,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    modifiers: modifiers | ownModifier,
  };
}

export async function pollCdpEndpoint(port, timeoutMs = 10_000, targetId) {
  return waitForCondition(
    async () => {
      const pages = await Promise.any(
        ['localhost', '127.0.0.1', '[::1]'].map(async (host) => {
          const response = await fetch(`http://${host}:${port}/json/list`);
          if (!response.ok) throw new Error(`CDP endpoint returned ${response.status}`);
          return response.json();
        })
      );
      return (
        pages.find(
          (page) => page.type === 'page' && (targetId === undefined || page.id === targetId)
        ) ?? null
      );
    },
    {
      timeoutMs,
      description:
        targetId === undefined
          ? `CDP endpoint on port ${port}`
          : `CDP target ${targetId} on port ${port}`,
    }
  );
}

export class CdpClient {
  constructor(webSocketUrl, { timeoutMs = 10_000, WebSocketImpl = WebSocket } = {}) {
    this.webSocketUrl = webSocketUrl;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = { console: [], exceptions: [] };
  }

  async connect() {
    this.socket = new this.WebSocketImpl(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener(
        'error',
        (event) =>
          reject(
            new Error(
              `CDP WebSocket handshake failed for ${this.webSocketUrl}: ${event.error?.message ?? event.message ?? event.type}`
            )
          ),
        { once: true }
      );
    });
    this.socket.addEventListener('message', (event) => this.#handle(JSON.parse(event.data)));
    await this.command('Runtime.runIfWaitingForDebugger');
    await Promise.all([
      this.command('Runtime.enable'),
      this.command('Page.enable'),
      this.command('Log.enable'),
    ]);
    return this;
  }

  #handle(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') this.events.console.push(message.params);
    if (message.method === 'Log.entryAdded') this.events.console.push(message.params.entry);
    if (message.method === 'Runtime.exceptionThrown') this.events.exceptions.push(message.params);
  }

  command(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

export async function evaluate(client, expression) {
  const result = await client.command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(detail || 'CDP evaluation failed');
  }
  return result.result.value;
}

export function waitForExpression(client, expression, options) {
  return waitForCondition(() => evaluate(client, expression), options);
}

export function waitForSelector(client, selector, options) {
  return waitForExpression(client, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, {
    ...options,
    description: `selector ${selector}`,
  });
}

export async function click(client, selector) {
  await waitForSelector(client, selector);
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

export async function keyChord(client, keys) {
  let modifiers = 0;
  for (const key of keys) {
    await client.command('Input.dispatchKeyEvent', keyDispatchParams(key, 'keyDown', modifiers));
    modifiers |= keyInfo[key]?.[3] ?? 0;
  }
  for (const key of [...keys].reverse())
    await client.command('Input.dispatchKeyEvent', keyDispatchParams(key, 'keyUp', modifiers));
}

export function screenshot(client) {
  return client.command('Page.captureScreenshot', { format: 'png' }).then((value) => value.data);
}

export function html(client) {
  return evaluate(client, 'document.documentElement.outerHTML');
}

export function close(client) {
  client.socket?.close();
}

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  cleanupHarness,
  closeOwnedSession,
  failureConsoleMessage,
  finalizeHarness,
  launch,
  monitorImageDisplayBanners,
  redactedFailureReport,
  redactDiagnostic,
  removeSandboxDirectory,
} from './windows-tauri-e2e.mjs';

const expectedBrowserArgs =
  '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port=9555 --remote-allow-origins=*';

function createChild({ exitCode = null, signalCode = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = exitCode;
  child.signalCode = signalCode;
  return child;
}

test('launch terminates its owned child when CDP attachment fails', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const killSignals = [];
  child.kill = (signal = 'SIGTERM') => {
    killSignals.push(signal);
    child.exitCode = 1;
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', 1, signal));
    return true;
  };
  const launches = [];
  let owned;
  let closePipeCalls = 0;

  await assert.rejects(
    () =>
      launch([], { webviewUserData: 'C:/sandbox/webview2' }, launches, {
        findPort: async () => 9222,
        executable: () => 'C:/LightFrame.exe',
        spawnProcess: () => child,
        pollEndpoint: async () => {
          throw new Error('CDP unavailable');
        },
        createDebuggerPipe: async () => ({
          target: Promise.reject(new Error('CDP unavailable')),
          close: async () => {
            closePipeCalls += 1;
          },
        }),
        onOwned: (session) => {
          owned = session;
        },
      }),
    /CDP unavailable/
  );

  assert.equal(owned.closed, true);
  assert.deepEqual(killSignals, ['SIGTERM']);
  assert.equal(launches.length, 1);
  assert.match(launches[0].attachFailure, /CDP unavailable/);
  assert.deepEqual(launches[0].exit, { code: 1, signal: 'SIGTERM' });
  assert.equal(closePipeCalls, 1);
});

test('launch does not kill an already-exited owned child after attach failure', async () => {
  const child = createChild({ exitCode: 1 });
  child.kill = () => assert.fail('already-exited child must not be killed');
  await assert.rejects(
    () =>
      launch([], {}, [], {
        findPort: async () => 9222,
        executable: () => 'C:/LightFrame.exe',
        spawnProcess: () => child,
        pollEndpoint: async () => {
          throw new Error('attach failed');
        },
        createDebuggerPipe: async () => ({
          target: Promise.reject(new Error('attach failed')),
          close: async () => undefined,
        }),
      }),
    /attach failed/
  );
});

test('launch ignores another page and retries the exact debugger-pipe target until it connects', async () => {
  const child = createChild({ exitCode: 0 });
  const connectedPages = [];
  const endpointSnapshots = [
    [{ type: 'page', id: 'other-page' }],
    [
      { type: 'page', id: 'other-page' },
      {
        type: 'page',
        id: 'exact-target',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/exact-target',
      },
    ],
    [
      {
        type: 'page',
        id: 'exact-target',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/exact-target',
      },
    ],
  ];
  let exactPollCalls = 0;

  const session = await launch([], {}, [], {
    findPort: async () => 9222,
    executable: () => 'C:/LightFrame.exe',
    spawnProcess: () => child,
    pollEndpoint: async (port, timeoutMs, targetId) => {
      assert.equal(port, 9222);
      assert.ok(timeoutMs > 0);
      assert.equal(targetId, 'exact-target');
      const pages = endpointSnapshots[exactPollCalls++] ?? endpointSnapshots.at(-1);
      const exactPage = pages.find((page) => page.id === targetId);
      if (!exactPage) throw new Error('Only another CDP page is available');
      return exactPage;
    },
    createDebuggerPipe: async () => ({
      target: Promise.resolve({ type: 'page', id: 'exact-target' }),
      close: async () => undefined,
    }),
    connectClient: async (page) => {
      connectedPages.push(page);
      if (connectedPages.length === 1) throw new Error('Exact target handshake not ready');
      return { socket: { close: () => undefined }, events: { console: [], exceptions: [] } };
    },
    retryDelayMs: 0,
  });

  assert.equal(session.cdp.events.console.length, 0);
  assert.equal(exactPollCalls, 3);
  assert.equal(connectedPages.length, 2);
  assert.ok(connectedPages.every((page) => page.id === 'exact-target'));
});

test('exact debugger-pipe target polling stops when the LightFrame child exits', async () => {
  const child = createChild();

  await assert.rejects(
    () =>
      launch([], {}, [], {
        findPort: async () => 9222,
        executable: () => 'C:/LightFrame.exe',
        spawnProcess: () => child,
        pollEndpoint: async (_port, _timeoutMs, targetId) => {
          if (targetId === undefined) return new Promise(() => {});
          queueMicrotask(() => {
            child.exitCode = 9;
            child.emit('exit', 9, null);
          });
          return new Promise(() => {});
        },
        createDebuggerPipe: async () => ({
          target: Promise.resolve({ type: 'page', id: 'exact-target' }),
          close: async () => undefined,
        }),
        attachTimeoutMs: 1_000,
      }),
    /LightFrame exited before CDP attach \(code=9, signal=null\)/
  );
});

test('launch uses a valid configured CDP port and forwards it to WebView2', async () => {
  const previousPort = process.env.LIGHTFRAME_E2E_CDP_PORT;
  const child = createChild({ exitCode: 0 });
  let polledPort;
  let spawnedEnvironment;
  let findPortCalls = 0;
  process.env.LIGHTFRAME_E2E_CDP_PORT = '9555';

  try {
    await launch([], {}, [], {
      findPort: async () => {
        findPortCalls += 1;
        return 9444;
      },
      executable: () => 'C:/LightFrame.exe',
      spawnProcess: (_path, _args, options) => {
        spawnedEnvironment = options.env;
        return child;
      },
      pollEndpoint: async (port) => {
        polledPort = port;
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/configured' };
      },
      createDebuggerPipe: async () => ({
        target: Promise.resolve({ type: 'page', id: 'configured' }),
        close: async () => undefined,
      }),
      connectClient: async () => ({
        socket: { close: () => undefined },
        events: { console: [], exceptions: [] },
      }),
    });
  } finally {
    if (previousPort === undefined) delete process.env.LIGHTFRAME_E2E_CDP_PORT;
    else process.env.LIGHTFRAME_E2E_CDP_PORT = previousPort;
  }

  assert.equal(findPortCalls, 0);
  assert.equal(polledPort, 9555);
  assert.equal(spawnedEnvironment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, expectedBrowserArgs);
});

test('launch overwrites inherited WebView2 browser arguments with its selected CDP port', async () => {
  const previousPort = process.env.LIGHTFRAME_E2E_CDP_PORT;
  const previousBrowserArgs = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  const child = createChild({ exitCode: 0 });
  let spawnedEnvironment;
  process.env.LIGHTFRAME_E2E_CDP_PORT = '9555';
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--stale-argument';

  try {
    await launch([], {}, [], {
      executable: () => 'C:/LightFrame.exe',
      spawnProcess: (_path, _args, options) => {
        spawnedEnvironment = options.env;
        return child;
      },
      pollEndpoint: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/configured',
      }),
      createDebuggerPipe: async () => ({
        target: Promise.resolve({ type: 'page', id: 'configured' }),
        close: async () => undefined,
      }),
      connectClient: async () => ({
        socket: { close: () => undefined },
        events: { console: [], exceptions: [] },
      }),
    });
  } finally {
    if (previousPort === undefined) delete process.env.LIGHTFRAME_E2E_CDP_PORT;
    else process.env.LIGHTFRAME_E2E_CDP_PORT = previousPort;
    if (previousBrowserArgs === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
    else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previousBrowserArgs;
  }

  assert.equal(spawnedEnvironment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, expectedBrowserArgs);
  assert.doesNotMatch(spawnedEnvironment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, /stale/);
});

test('config mode removes inherited WebView2 browser arguments from the child environment', async () => {
  const previousPort = process.env.LIGHTFRAME_E2E_CDP_PORT;
  const previousConfigMode = process.env.LIGHTFRAME_E2E_BROWSER_ARGS_IN_CONFIG;
  const previousBrowserArgs = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  const child = createChild({ exitCode: 0 });
  let spawnedEnvironment;
  process.env.LIGHTFRAME_E2E_CDP_PORT = '9555';
  process.env.LIGHTFRAME_E2E_BROWSER_ARGS_IN_CONFIG = '1';
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--inherited-stale-argument';

  try {
    await launch([], {}, [], {
      executable: () => 'C:/LightFrame.exe',
      spawnProcess: (_path, _args, options) => {
        spawnedEnvironment = options.env;
        return child;
      },
      pollEndpoint: async () => ({
        type: 'page',
        id: 'configured',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/configured',
      }),
      createDebuggerPipe: async () => ({
        target: Promise.resolve({ type: 'page', id: 'configured' }),
        close: async () => undefined,
      }),
      connectClient: async () => ({
        socket: { close: () => undefined },
        events: { console: [], exceptions: [] },
      }),
    });
  } finally {
    if (previousPort === undefined) delete process.env.LIGHTFRAME_E2E_CDP_PORT;
    else process.env.LIGHTFRAME_E2E_CDP_PORT = previousPort;
    if (previousConfigMode === undefined) delete process.env.LIGHTFRAME_E2E_BROWSER_ARGS_IN_CONFIG;
    else process.env.LIGHTFRAME_E2E_BROWSER_ARGS_IN_CONFIG = previousConfigMode;
    if (previousBrowserArgs === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
    else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previousBrowserArgs;
  }

  assert.equal(spawnedEnvironment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined);
});

test('launch ignores invalid configured CDP ports and uses the free-port provider', async () => {
  const previousPort = process.env.LIGHTFRAME_E2E_CDP_PORT;
  const child = createChild({ exitCode: 0 });
  const selectedPorts = [];
  process.env.LIGHTFRAME_E2E_CDP_PORT = '70000';

  try {
    await launch([], {}, [], {
      findPort: async () => 9444,
      executable: () => 'C:/LightFrame.exe',
      spawnProcess: () => child,
      pollEndpoint: async (port) => {
        selectedPorts.push(port);
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/fallback' };
      },
      createDebuggerPipe: async () => ({
        target: Promise.resolve({ type: 'page', id: 'fallback' }),
        close: async () => undefined,
      }),
      connectClient: async () => ({
        socket: { close: () => undefined },
        events: { console: [], exceptions: [] },
      }),
    });
  } finally {
    if (previousPort === undefined) delete process.env.LIGHTFRAME_E2E_CDP_PORT;
    else process.env.LIGHTFRAME_E2E_CDP_PORT = previousPort;
  }

  assert.deepEqual(selectedPorts, [9444]);
});

test('Windows CI E2E builds with an isolated test config and preserves the production config', async () => {
  const workflow = await readFile(resolve(import.meta.dirname, '../../.github/workflows/ci.yml'), {
    encoding: 'utf8',
  });

  assert.match(workflow, /LIGHTFRAME_E2E_TAURI_CONFIG/);
  assert.match(workflow, /pnpm tauri build --no-bundle --ci --config/);
  assert.match(workflow, /pnpm run e2e:windows/);
  assert.match(workflow, /additionalBrowserArgs/);
  assert.match(workflow, /LIGHTFRAME_E2E_BROWSER_ARGS_IN_CONFIG/);
  assert.match(workflow, /RUNNER_TEMP[\s\S]*lightframe-tauri-e2e\.conf\.json/);
  assert.match(workflow, /--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection/);
  assert.match(workflow, /--autoplay-policy=no-user-gesture-required/);
  assert.match(workflow, /--remote-debugging-port=\$cdpPort --remote-allow-origins=\*/);
  assert.doesNotMatch(workflow, /Set-Content[^\r\n]*tauri\.conf\.json/);

  const listenerStart = workflow.indexOf('$listener.Start()');
  const build = workflow.indexOf('pnpm tauri build --no-bundle --ci --config');
  const listenerStop = workflow.indexOf('$listener.Stop()');
  const e2e = workflow.indexOf('pnpm run e2e:windows');
  assert.ok(listenerStart < build, 'CDP port reservation must start before the build');
  assert.ok(build < listenerStop, 'CDP port reservation must remain held throughout the build');
  assert.ok(listenerStop < e2e, 'CDP port reservation must be released immediately before E2E');
});

test('Tauri CSP permits the native IPC transports used during startup', async () => {
  const config = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../../src-tauri/tauri.conf.json'), {
      encoding: 'utf8',
    })
  );
  const connectSources = config.app.security.csp
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src')
    ?.slice(1);

  assert.ok(connectSources, 'Tauri CSP must define connect-src');
  assert.ok(connectSources.includes('ipc:'), 'Tauri CSP must allow the ipc: transport');
  assert.ok(
    connectSources.includes('http://ipc.localhost'),
    'Tauri CSP must allow the Windows IPC host'
  );
});

test('owned process-tree termination failure is surfaced without killing another process', async () => {
  const child = createChild();
  child.kill = () => assert.fail('child.kill must not run after taskkill failure');
  const session = {
    child,
    cdp: null,
    entry: {},
    terminateProcessTree: async (ownedChild) => {
      assert.equal(ownedChild, child);
      throw new Error('taskkill failed for owned parent tree');
    },
  };

  await assert.rejects(() => closeOwnedSession(session), /taskkill failed for owned parent tree/);
  assert.equal(session.closed, undefined);
});

test('owned process tree cleanup observes an exit set without a later exit event', async () => {
  const child = createChild();
  child.kill = () => assert.fail('an exited child must not be killed');
  const session = {
    child,
    cdp: null,
    entry: {},
    terminateProcessTree: async () => {
      child.exitCode = 23;
    },
    waitForChildExit: async () => assert.fail('already-exited child must not be awaited'),
  };

  await closeOwnedSession(session);

  assert.equal(session.closed, true);
  assert.deepEqual(session.entry.exit, { code: 23, signal: null });
});

test('attach failure retains its cause when owned process cleanup also fails', async () => {
  const child = createChild();
  child.kill = () => assert.fail('child.kill must not run after taskkill failure');

  await assert.rejects(
    () =>
      launch([], {}, [], {
        findPort: async () => 9222,
        executable: () => 'C:/LightFrame.exe',
        spawnProcess: () => child,
        pollEndpoint: async () => {
          throw new Error('CDP unavailable');
        },
        createDebuggerPipe: async () => ({
          target: Promise.reject(new Error('CDP unavailable')),
          close: async () => undefined,
        }),
        terminateProcessTree: async () => {
          throw new Error('taskkill failed for owned parent tree');
        },
      }),
    (error) => {
      assert.match(error.message, /CDP unavailable/);
      assert.match(error.message, /Cleanup failed: Error: taskkill failed for owned parent tree/);
      return true;
    }
  );
});

test('sandbox/profile cleanup failure is surfaced', async () => {
  const error = await cleanupHarness(undefined, undefined, 'C:/lightframe-e2e/userprofile', {
    removeSandbox: async (path) => {
      assert.equal(path, 'C:/lightframe-e2e/userprofile');
      throw new Error('EPERM: sandbox profile remains in use');
    },
  });

  assert.match(error.message, /Cleanup failed: Error: EPERM: sandbox profile remains in use/);
});

test('residual owned process cleanup failure is surfaced', async () => {
  const child = createChild();
  const killSignals = [];
  child.kill = (signal = 'SIGTERM') => {
    killSignals.push(signal);
    return true;
  };
  const session = {
    child,
    cdp: null,
    entry: {},
    terminateProcessTree: async () => undefined,
    waitForChildExit: async () => null,
  };

  const error = await cleanupHarness(undefined, session, 'C:/lightframe-e2e', {
    removeSandbox: async () => undefined,
  });

  assert.match(error.message, /Cleanup failed: Error: Owned process <unknown> did not exit/);
  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(session.closed, undefined);
});

test('cleanup failure details are retained alongside the original journey error', async () => {
  const journeyError = new Error('navigation journey failed');
  const error = await cleanupHarness(journeyError, { child: null }, 'C:/lightframe-e2e', {
    closeOwnedSession: async () => {
      throw new Error('owned process remained');
    },
    removeSandbox: async () => {
      throw new Error('sandbox remained');
    },
  });

  assert.equal(error, journeyError);
  assert.match(error.message, /navigation journey failed/);
  assert.match(error.message, /Cleanup failed: Error: owned process remained/);
  assert.match(error.message, /Cleanup failed: Error: sandbox remained/);
});

test('successful and already-exited owned cleanup remain green', async () => {
  const child = createChild({ exitCode: 0 });
  child.kill = () => assert.fail('already-exited child must not be killed');
  const session = { child, cdp: null, entry: {} };
  let removed = false;

  const error = await cleanupHarness(undefined, session, 'C:/lightframe-e2e', {
    removeSandbox: async () => {
      removed = true;
    },
  });

  assert.equal(error, undefined);
  assert.equal(session.closed, true);
  assert.deepEqual(session.entry.exit, { code: 0, signal: null });
  assert.equal(removed, true);
});

test('attach failure before launch returns still clears and verifies its sandbox', async () => {
  const child = createChild();
  child.kill = (signal = 'SIGTERM') => {
    child.exitCode = 1;
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', 1, signal));
    return true;
  };
  let owned;
  let attachError;
  try {
    await launch([], {}, [], {
      findPort: async () => 9222,
      executable: () => 'C:/LightFrame.exe',
      spawnProcess: () => child,
      pollEndpoint: async () => {
        throw new Error('CDP unavailable');
      },
      createDebuggerPipe: async () => ({
        target: Promise.reject(new Error('CDP unavailable')),
        close: async () => undefined,
      }),
      onOwned: (session) => {
        owned = session;
      },
    });
  } catch (error) {
    attachError = error;
  }

  let sandboxExists = true;
  let attributesCleared = false;
  let removed = false;
  const cleanupError = await cleanupHarness(
    attachError,
    owned,
    'C:/Users/ExampleUser/AppData/Local/Temp/lightframe-e2e-test',
    {
      removeSandbox: (sandbox) =>
        removeSandboxDirectory(sandbox, {
          pathExists: () => sandboxExists,
          clearAttributes: async () => {
            attributesCleared = true;
          },
          removeDirectory: async () => {
            removed = true;
            sandboxExists = false;
          },
        }),
    }
  );

  assert.equal(cleanupError, attachError);
  assert.equal(owned.closed, true);
  assert.equal(attributesCleared, true);
  assert.equal(removed, true);
  assert.equal(sandboxExists, false);
});

test('sandbox cleanup reports a directory that remains after removal', async () => {
  await assert.rejects(
    () =>
      removeSandboxDirectory('C:/lightframe-e2e-remains', {
        pathExists: () => true,
        clearAttributes: async () => undefined,
        removeDirectory: async () => undefined,
      }),
    /sandbox remains after cleanup/
  );
});

test('successful result writing waits for cleanup and is skipped when cleanup fails', async () => {
  const result = { completedAt: '2026-08-04T00:00:00.000Z' };
  const cleanupFailure = new Error('sandbox remains after cleanup');
  const failedOrder = [];
  const failure = await finalizeHarness(result, undefined, undefined, 'C:/sandbox', {
    cleanup: async () => {
      failedOrder.push('cleanup');
      return cleanupFailure;
    },
    writeResult: async () => failedOrder.push('result'),
  });

  assert.equal(failure, cleanupFailure);
  assert.deepEqual(failedOrder, ['cleanup']);

  const successfulOrder = [];
  const successfulFailure = await finalizeHarness(result, undefined, undefined, 'C:/sandbox', {
    cleanup: async () => {
      successfulOrder.push('cleanup');
      return undefined;
    },
    writeResult: async () => successfulOrder.push('result'),
  });

  assert.equal(successfulFailure, undefined);
  assert.deepEqual(successfulOrder, ['cleanup', 'result']);
});

test('failure reports redact Windows paths while preserving CDP WebSocket URLs', () => {
  const error = new Error('CDP failure at C:/Users/ExampleUser/Projects/lightframe/secret');
  error.stack =
    'Error: CDP failure\n    at main (file:///C:/Users/ExampleUser/Projects/lightframe/scripts/e2e/windows-tauri-e2e.mjs:1:1)';
  const report = redactedFailureReport(
    {
      launches: [
        {
          attachFailure: 'profile C:/Users/ExampleUser/AppData/Local/Temp/lightframe-e2e-private',
          logs: 'CDP ws://localhost:9222/devtools/page/id from "C:\\Program Files (x86)\\Example User\\LightFrame\\app.exe" and C:\\Users\\ExampleUser\\Workspace Folder\\viewer.mjs',
        },
      ],
    },
    error,
    { files: ['launch-logs.json'], captureErrors: ['C:/Users/ExampleUser/diagnostic failure'] }
  );
  const serialized = JSON.stringify(report);
  const consoleMessage = failureConsoleMessage(error);

  assert.doesNotMatch(serialized, /C:[\\/]Users[\\/]ExampleUser/i);
  assert.doesNotMatch(serialized, /C:\\Program Files \(x86\)\\Example User/i);
  assert.doesNotMatch(serialized, /\(x86\)/i);
  assert.match(serialized, /<redacted-path>/);
  assert.match(serialized, /ws:\/\/localhost:9222\/devtools\/page\/id/);
  assert.doesNotMatch(consoleMessage, /C:[\\/]/);
  assert.match(consoleMessage, /inspect artifacts\/windows-e2e/);
});

test('diagnostic redaction handles UNC paths with spaces without changing WebSocket URLs', () => {
  const diagnostic =
    'ws://localhost:9222/devtools/page/id could not read \\\\fileserver\\\\Shared Folder\\\\WebView Cache\\\\data';
  const redacted = redactDiagnostic(diagnostic);

  assert.match(redacted, /ws:\/\/localhost:9222\/devtools\/page\/id/);
  assert.doesNotMatch(redacted, /\\\\fileserver\\Shared Folder/i);
  assert.match(redacted, /<redacted-path>/);

  const pathThenWebSocket = redactDiagnostic(
    'C:\\Program Files\\Example User\\LightFrame\\app.exe ws://localhost:9222/devtools/page/id'
  );
  assert.match(pathThenWebSocket, /ws:\/\/localhost:9222\/devtools\/page\/id/);
  assert.doesNotMatch(pathThenWebSocket, /C:\\Program Files/i);
});

test('rapid navigation banner monitor captures transient image display banners', async () => {
  const operations = [];
  let releaseWait;

  const monitorPromise = monitorImageDisplayBanners({}, async () => 'navigation-complete', {
    evaluatePage: async (_cdp, expression) => {
      if (expression.includes('MutationObserver')) operations.push('install');
      if (expression.includes('delete window')) {
        operations.push('collect');
        return ['Could not display image: C:/fixture/demo-02.png'];
      }
      return true;
    },
    wait: async (ms) => {
      operations.push(`wait:${ms}`);
      await new Promise((resolve) => {
        releaseWait = resolve;
      });
      operations.push('wait-resolved');
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(operations, ['install', 'wait:1000']);
  releaseWait?.();
  const { hits, result } = await monitorPromise;

  assert.equal(result, 'navigation-complete');
  assert.deepEqual(hits, ['Could not display image: C:/fixture/demo-02.png']);
  assert.deepEqual(operations, ['install', 'wait:1000', 'wait-resolved', 'collect', 'collect']);
});

test('rapid navigation banner monitor captures persistent image display banners', async () => {
  const { hits } = await monitorImageDisplayBanners({}, async () => undefined, {
    evaluatePage: async (_cdp, expression) => {
      if (expression.includes('disconnect')) {
        return ['Could not display image: C:/fixture/demo-04.png'];
      }
      return true;
    },
  });

  assert.deepEqual(hits, ['Could not display image: C:/fixture/demo-04.png']);
});

test('rapid navigation banner monitor cleans up while preserving navigation errors', async () => {
  const operations = [];

  await assert.rejects(
    monitorImageDisplayBanners(
      {},
      async () => {
        operations.push('during');
        throw new Error('navigation failed');
      },
      {
        evaluatePage: async (_cdp, expression) => {
          if (expression.includes('MutationObserver')) operations.push('install');
          if (expression.includes('delete window')) operations.push('collect');
          return [];
        },
        wait: async () => operations.push('wait'),
      }
    ),
    (error) => error instanceof Error && error.message === 'navigation failed'
  );

  assert.deepEqual(operations, ['install', 'during', 'collect']);
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  assertEqual,
  CdpClient,
  click,
  close,
  createDebuggerPipeServer,
  evaluate,
  fatalCdpEvents,
  getFreePort,
  html,
  keyChord,
  pollCdpEndpoint,
  screenshot,
  waitForExpression,
  waitForSelector,
} from './cdp-client.mjs';

const root = resolve(import.meta.dirname, '../..');
const artifacts = join(root, 'artifacts', 'windows-e2e');
const exe =
  process.env.LIGHTFRAME_E2E_EXE ?? join(root, 'src-tauri', 'target', 'release', 'lightframe.exe');
export const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z/D/PwAG/gL+DHWJ3gAAAABJRU5ErkJggg==',
  'base64'
);
export const redactDiagnostic = (value) =>
  String(value)
    .replace(
      /(^|[^A-Za-z0-9+.-])(?:file:\/\/\/)?(["'])(?:[A-Z]:[\\/]|\\\\)[\s\S]*?\2/gim,
      (_, boundary) => `${boundary}<redacted-path>`
    )
    .replace(
      /(^|[^A-Za-z0-9+.-])(?:(?:file:\/\/\/)?[A-Z]:[\\/](?:[^\s\r\n"'()]|\s+(?![A-Za-z][A-Za-z0-9+.-]*:\/\/))*|\\\\(?:[^\s\r\n"'()]|\s+(?![A-Za-z][A-Za-z0-9+.-]*:\/\/))*)/gim,
      (_, boundary) => `${boundary}<redacted-path>`
    )
    .replace(/lightframe-e2e-[^\\"\s]+/gi, '<sandbox>');
const redactDiagnostics = (value) => {
  if (typeof value === 'string') return redactDiagnostic(value);
  if (Array.isArray(value)) return value.map(redactDiagnostics);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDiagnostics(entry)])
    );
  return value;
};
const viewerState = (cdp) =>
  evaluate(
    cdp,
    '({ name: document.querySelector("[data-testid=viewer-filename]")?.textContent?.trim(), index: document.querySelector("[data-testid=viewer-index]")?.dataset.index })'
  );
const imageDisplayBannerMonitorKey = '__lightframeImageDisplayBannerMonitor';
const installImageDisplayBannerMonitorExpression = `(() => {
  const key = ${JSON.stringify(imageDisplayBannerMonitorKey)};
  window[key]?.disconnect?.();
  const hits = [];
  const record = () => {
    const banners = Array.from(document.querySelectorAll("[role=alert], .error-banner"))
      .map((node) => node.textContent?.trim() || "")
      .filter((text) => text.includes("Could not display image"));
    for (const banner of banners) hits.push(banner);
  };
  const observer = new MutationObserver(record);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  record();
  window[key] = {
    disconnect: () => {
      observer.disconnect();
      record();
      return hits.slice();
    },
  };
  return true;
})()`;
const collectImageDisplayBannerMonitorExpression = `(() => {
  const monitor = window[${JSON.stringify(imageDisplayBannerMonitorKey)}];
  if (!monitor) return [];
  const hits = monitor.disconnect();
  delete window[${JSON.stringify(imageDisplayBannerMonitorKey)}];
  return hits;
})()`;
const finalRapidNavigationImageExpression = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const filename = document.querySelector("[data-testid=viewer-filename]")?.textContent?.trim();
    const index = document.querySelector("[data-testid=viewer-index]")?.dataset.index;
    const total = document.querySelector("[data-testid=viewer-index]")?.dataset.total;
    const image = document.querySelector(".image-canvas img");
    resolve(
      filename === "demo-01.png" &&
        index === "1" &&
        total === "4" &&
        Boolean(image) &&
        image.complete === true &&
        image.naturalWidth > 0 &&
        !image.classList.contains("loading")
    );
  }));
})`;

export async function monitorImageDisplayBanners(cdp, during, dependencies = {}) {
  const {
    evaluatePage = evaluate,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    postSettleMs = 1_000,
  } = dependencies;
  await evaluatePage(cdp, installImageDisplayBannerMonitorExpression);

  try {
    const result = await during();
    await wait(postSettleMs);
    const hits = await evaluatePage(cdp, collectImageDisplayBannerMonitorExpression);
    return { result, hits };
  } finally {
    await evaluatePage(cdp, collectImageDisplayBannerMonitorExpression).catch(() => undefined);
  }
}

function recordJourney(result, journey) {
  result.journeys.push(journey);
  console.log(`[windows-e2e] ${journey.name}: ${journey.status}`);
}

export function requireWindowsExecutable(path = exe) {
  if (process.platform !== 'win32') throw new Error('e2e:windows must run on Windows.');
  if (!existsSync(path))
    throw new Error(
      `LightFrame executable not found: ${path}. Run pnpm tauri build --no-bundle --ci first, or set LIGHTFRAME_E2E_EXE.`
    );
  return path;
}

async function waitForExit(child, timeoutMs = 3_000) {
  if (child.exitCode != null) return { code: child.exitCode, signal: child.signalCode ?? null };
  let timeout;
  try {
    return await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectWebviewChildProcesses(parentPid) {
  if (process.platform !== 'win32' || !Number.isInteger(parentPid)) return [];
  const command = [
    `$all = Get-CimInstance Win32_Process`,
    `$children = $all | Where-Object { $_.ParentProcessId -eq ${parentPid} }`,
    `$children | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress`,
  ].join('; ');
  const output = await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((process) => ({
    ...process,
    CommandLine: redactDiagnostic(process.CommandLine),
  }));
}

export async function closeOwnedSession(session) {
  if (!session || session.closed) return;
  if (session.cdp) close(session.cdp);
  const exit = await terminateChild(
    session.child,
    session.terminateProcessTree,
    session.waitForChildExit
  );
  session.entry.exit = exit ?? timedOutExit(session.child);
  if (!exit)
    throw new Error(
      `Owned process ${session.child.pid ?? '<unknown>'} did not exit after termination`
    );
  session.closed = true;
}

async function terminateChild(
  child,
  terminateProcessTree = terminateOwnedProcessTree,
  waitForChildExit = waitForExit
) {
  if (child.exitCode != null) return { code: child.exitCode, signal: child.signalCode ?? null };
  await terminateProcessTree(child);
  if (child.exitCode != null) return { code: child.exitCode, signal: child.signalCode ?? null };
  if (child.exitCode == null) child.kill();
  let exit = await waitForChildExit(child);
  if (!exit && child.exitCode == null) {
    child.kill('SIGKILL');
    exit = await waitForChildExit(child);
  }
  return exit;
}

async function terminateOwnedProcessTree(child) {
  if (process.platform !== 'win32' || !Number.isInteger(child.pid) || child.exitCode != null)
    return;
  await new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function cleanupFailure(originalError, cleanupError) {
  const detail = `Cleanup failed: ${String(cleanupError)}`;
  if (!originalError) return new Error(detail);
  originalError.message = `${originalError.message}\n${detail}`;
  return originalError;
}

async function clearSandboxAttributes(sandbox) {
  if (process.platform !== 'win32' || !existsSync(sandbox)) return;
  await new Promise((resolve, reject) => {
    execFile('attrib.exe', ['-R', '-S', '-H', sandbox, '/S', '/D'], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function removeSandboxDirectory(sandbox, dependencies = {}) {
  const {
    clearAttributes = clearSandboxAttributes,
    removeDirectory = (path) =>
      rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }),
    pathExists = existsSync,
  } = dependencies;
  if (!pathExists(sandbox)) return;
  let attributeError;
  try {
    await clearAttributes(sandbox);
  } catch (error) {
    attributeError = error;
  }
  try {
    await removeDirectory(sandbox);
  } catch (error) {
    throw new Error(
      `sandbox removal failed: ${String(error)}${
        attributeError ? `; attribute clearing failed: ${String(attributeError)}` : ''
      }`,
      { cause: error }
    );
  }
  if (pathExists(sandbox))
    throw new Error(
      `sandbox remains after cleanup${
        attributeError ? `; attribute clearing failed: ${String(attributeError)}` : ''
      }`
    );
}

export async function cleanupHarness(originalError, session, sandbox, dependencies = {}) {
  const {
    closeOwnedSession: closeSession = closeOwnedSession,
    removeSandbox = removeSandboxDirectory,
  } = dependencies;
  let result = originalError;
  try {
    await closeSession(session);
  } catch (cleanupError) {
    result = cleanupFailure(result, cleanupError);
  }
  try {
    await withTimeout(removeSandbox(sandbox), 5_000, 'sandbox cleanup timed out');
  } catch (cleanupError) {
    result = cleanupFailure(result, cleanupError);
  }
  return result;
}

export async function finalizeHarness(result, failure, session, sandbox, dependencies = {}) {
  const {
    cleanup = cleanupHarness,
    writeResult = (value) =>
      writeFile(join(artifacts, 'result.json'), JSON.stringify(redactDiagnostics(value), null, 2)),
  } = dependencies;
  const cleanupError = await cleanup(failure, session, sandbox);
  if (cleanupError) return cleanupError;
  await writeResult(result);
  return undefined;
}

export function redactedFailureReport(result, error, artifacts) {
  return redactDiagnostics({
    ...result,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
    artifacts: artifacts.files,
    captureErrors: artifacts.captureErrors,
  });
}

export function failureConsoleMessage(error) {
  return `Windows E2E failed; inspect artifacts/windows-e2e: ${redactDiagnostic(error.message)}`;
}

function timedOutExit(child) {
  return {
    code: child.exitCode,
    signal: child.signalCode,
    timedOut: true,
  };
}

function webviewCdpBrowserArguments(port) {
  return `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port=${port} --remote-allow-origins=*`;
}

function debuggerPipeTargetId(target) {
  if (typeof target?.id === 'string' && target.id) return target.id;
  if (typeof target?.webSocketDebuggerUrl === 'string') {
    const match = new URL(target.webSocketDebuggerUrl).pathname.match(/\/devtools\/page\/([^/]+)$/);
    if (match?.[1]) return match[1];
  }
  throw new Error('Debugger pipe target did not identify a page');
}

function remainingTime(deadline, now) {
  return Math.max(0, deadline - now());
}

async function attachCdp(session, port, pollEndpoint, debuggerPipe, connectClient, options = {}) {
  const {
    timeoutMs = 15_000,
    connectAttemptTimeoutMs = 1_500,
    retryDelayMs = 100,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const deadline = now() + timeoutMs;
  const childExit = prematureExit(session.child);
  const pipeTarget = await withTimeout(
    Promise.race([debuggerPipe.target, childExit]),
    remainingTime(deadline, now),
    `Timed out waiting for the debugger-pipe target on port ${port}`
  );
  const targetId = debuggerPipeTargetId(pipeTarget);
  const failures = [];
  session.entry.exactTargetFailures = failures;
  while (remainingTime(deadline, now) > 0) {
    const remaining = remainingTime(deadline, now);
    try {
      const exactPage = await withTimeout(
        Promise.race([pollEndpoint(port, remaining, targetId), childExit]),
        remaining,
        `Timed out polling CDP target ${targetId} on port ${port}`
      );
      return await withTimeout(
        Promise.race([connectClient(exactPage), childExit]),
        Math.min(connectAttemptTimeoutMs, remainingTime(deadline, now)),
        `Timed out connecting to CDP target ${targetId} on port ${port}`
      );
    } catch (error) {
      if (error?.code === 'LIGHTFRAME_PREMATURE_EXIT') {
        throw error;
      }
      failures.push(redactDiagnostic(error));
    }

    const remainingAfterAttempt = remainingTime(deadline, now);
    if (remainingAfterAttempt <= 0) break;
    await Promise.race([wait(Math.min(retryDelayMs, remainingAfterAttempt)), childExit]);
  }
  throw new Error(
    `Timed out attaching to CDP target ${targetId} on port ${port}: ${failures.at(-1) ?? 'target unavailable'}`
  );
}

function prematureExit(child) {
  return new Promise((_, reject) => {
    child.once('error', (error) => {
      const failure = new Error(`LightFrame spawn failed: ${error.message}`);
      failure.code = 'LIGHTFRAME_PREMATURE_EXIT';
      reject(failure);
    });
    child.once('exit', (code, signal) => {
      const failure = new Error(
        `LightFrame exited before CDP attach (code=${code}, signal=${signal})`
      );
      failure.code = 'LIGHTFRAME_PREMATURE_EXIT';
      reject(failure);
    });
  });
}

async function captureAttachFailure(session, error) {
  session.entry.attachFailure = redactDiagnostic(error);
  try {
    if (Number.isInteger(session.child.pid)) {
      session.entry.webviewChildren = await inspectWebviewChildProcesses(session.child.pid);
      console.error(
        `[windows-e2e] CDP attach failed; WebView2 child processes: ${JSON.stringify(session.entry.webviewChildren)}`
      );
    }
  } catch (inspectionError) {
    session.entry.webviewInspectionFailure = redactDiagnostic(inspectionError);
    console.error(
      `[windows-e2e] failed to inspect WebView2 child: ${redactDiagnostic(inspectionError)}`
    );
  }
  await closeOwnedSession(session);
}

export async function launch(args, paths, launchLogs, dependencies = {}) {
  const {
    findPort = getFreePort,
    spawnProcess = spawn,
    pollEndpoint = pollCdpEndpoint,
    connectClient = (page) => new CdpClient(page.webSocketDebuggerUrl).connect(),
    executable = requireWindowsExecutable,
    createDebuggerPipe = createDebuggerPipeServer,
    onOwned = () => undefined,
    terminateProcessTree = terminateOwnedProcessTree,
    waitForChildExit = waitForExit,
    attachTimeoutMs,
    connectAttemptTimeoutMs,
    retryDelayMs,
    now,
    wait,
  } = dependencies;
  const configuredPort = Number.parseInt(process.env.LIGHTFRAME_E2E_CDP_PORT ?? '', 10);
  const port = configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : await findPort();
  const browserArgsInConfig = process.env.LIGHTFRAME_E2E_BROWSER_ARGS_IN_CONFIG === '1';
  const executablePath = executable();
  const pipeName = `lightframe-e2e-${process.pid}-${Date.now()}`;
  const debuggerPipe = await createDebuggerPipe(basename(executablePath), pipeName);
  const baseEnv = { ...process.env };
  delete baseEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  const childEnv = {
    ...baseEnv,
    ...(browserArgsInConfig
      ? {}
      : {
          APPDATA: paths.appData,
          LOCALAPPDATA: paths.localAppData,
          USERPROFILE: paths.userProfile,
        }),
    TEMP: paths.temp,
    TMP: paths.temp,
    WEBVIEW2_USER_DATA_FOLDER: paths.webviewUserData,
    WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER: pipeName,
    ...(browserArgsInConfig
      ? {}
      : { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webviewCdpBrowserArguments(port) }),
  };
  const child = spawnProcess(executablePath, args, {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => {
    logs += data;
  });
  child.stderr.on('data', (data) => {
    logs += data;
  });
  const entry = {
    args: args.map((arg) => (arg.includes('lightframe-e2e-') ? '<sandbox>' : arg)),
    logs: () => logs,
    port,
  };
  const session = {
    child,
    cdp: null,
    logs: () => logs,
    entry,
    terminateProcessTree,
    waitForChildExit,
  };
  launchLogs.push(entry);
  onOwned(session);
  try {
    session.cdp = await attachCdp(session, port, pollEndpoint, debuggerPipe, connectClient, {
      timeoutMs: attachTimeoutMs,
      connectAttemptTimeoutMs,
      retryDelayMs,
      now,
      wait,
    });
    return session;
  } catch (error) {
    try {
      await captureAttachFailure(session, error);
    } catch (cleanupError) {
      throw cleanupFailure(error, cleanupError);
    }
    throw error;
  } finally {
    await debuggerPipe.close();
  }
}

async function runHomeStartup(session, result) {
  const startupWait = { timeoutMs: 30_000 };
  await waitForSelector(
    session.cdp,
    '[data-testid="native-app-root"][data-runtime-ready="true"]',
    startupWait
  );
  await waitForSelector(session.cdp, '[data-testid="home-screen"]', startupWait);
  recordJourney(result, { name: 'home', status: 'passed' });
  if (fatalCdpEvents(session.cdp.events).length) throw new Error('CDP error after home journey');
}

async function runFolderStartup(session, result) {
  await waitForSelector(session.cdp, '[data-testid="native-app-root"][data-runtime-ready="true"]');
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-index]")?.dataset.total === "4"'
  );
  const state = await viewerState(session.cdp);
  if (state.name !== 'demo-01.png' || state.index !== '1')
    throw new Error(`Unexpected startup selection: ${JSON.stringify(state)}`);
  recordJourney(result, { name: 'folder-startup', status: 'passed', state });
}

async function runNavigationGrid(session, result) {
  await keyChord(session.cdp, ['ArrowRight']);
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-index]")?.dataset.index === "2"'
  );
  let navigation = await viewerState(session.cdp);
  assertEqual(navigation.name, 'demo-02.png', 'next filename');
  await keyChord(session.cdp, ['ArrowLeft']);
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-index]")?.dataset.index === "1"'
  );
  navigation = await viewerState(session.cdp);
  assertEqual(navigation.name, 'demo-01.png', 'previous filename');
  await keyChord(session.cdp, ['g']);
  await waitForSelector(session.cdp, '[data-testid="grid-root"]');
  assertEqual(
    await evaluate(
      session.cdp,
      'document.querySelector("[data-testid=grid-root]")?.dataset.totalCount'
    ),
    '4',
    'grid total count'
  );
  await keyChord(session.cdp, ['g']);
  await waitForSelector(session.cdp, '[data-testid="viewer-index"]');
  recordJourney(result, { name: 'navigation-grid', status: 'passed' });
}

async function runRapidOverlappingNavigation(session, result) {
  await waitForSelector(session.cdp, '[data-testid="viewer-index"]');
  const { hits } = await monitorImageDisplayBanners(session.cdp, async () => {
    const navigationBursts = [
      ...Array.from({ length: 8 }, () => keyChord(session.cdp, ['ArrowRight'])),
      ...Array.from({ length: 8 }, () => keyChord(session.cdp, ['ArrowLeft'])),
    ];
    await Promise.all(navigationBursts);
    await waitForExpression(session.cdp, finalRapidNavigationImageExpression, {
      description: 'settled rapid-navigation final image',
    });
  });
  if (hits.length) {
    throw new Error(`Unexpected image display banner during rapid navigation: ${hits.join(' | ')}`);
  }
  const state = await viewerState(session.cdp);
  assertEqual(state.name, 'demo-01.png', 'rapid navigation final filename');
  assertEqual(state.index, '1', 'rapid navigation final index');
  recordJourney(result, { name: 'rapid-overlapping-navigation', status: 'passed', state });
}

async function runCuration(session) {
  await click(session.cdp, '#btn-favorite');
  await click(session.cdp, '[aria-label="Set rating 4"]');
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-favorite]")?.dataset.favorite === "true"'
  );
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-rating]")?.dataset.rating === "4"'
  );
}

async function runCurationPersistence(session, result) {
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-index]")?.dataset.index === "1"'
  );
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-favorite]")?.dataset.favorite === "true"'
  );
  await waitForExpression(
    session.cdp,
    'document.querySelector("[data-testid=viewer-rating]")?.dataset.rating === "4"'
  );
  recordJourney(result, { name: 'curation-persistence', status: 'passed' });
}

async function runShortcutDialogs(session, result) {
  await keyChord(session.cdp, ['Control', ',']);
  await waitForSelector(session.cdp, '[data-testid="settings-dialog"]');
  await keyChord(session.cdp, ['Escape']);
  await waitForExpression(session.cdp, '!document.querySelector("[data-testid=settings-dialog]")');
  await keyChord(session.cdp, ['Control', 'k']);
  await waitForSelector(session.cdp, '[data-testid="command-palette-dialog"]');
  await keyChord(session.cdp, ['Escape']);
  await waitForExpression(
    session.cdp,
    '!document.querySelector("[data-testid=command-palette-dialog]")'
  );
  recordJourney(result, { name: 'settings-command-palette', status: 'passed' });
}

async function captureFailureArtifacts(session, result) {
  const captureErrors = [];
  const files = [];
  const capture = async (name, action) => {
    try {
      await action();
      files.push(name);
    } catch (captureError) {
      captureErrors.push(`${name}: ${redactDiagnostic(captureError)}`);
    }
  };
  if (session?.cdp) {
    await capture('cdp-events.json', () =>
      writeFile(
        join(artifacts, 'cdp-events.json'),
        JSON.stringify(redactDiagnostics(session.cdp.events), null, 2)
      )
    );
    await capture('page-state.json', async () => {
      const state = await session.cdp.command('Runtime.evaluate', {
        expression:
          'JSON.stringify({href: location.href, readyState: document.readyState, title: document.title, html: document.documentElement?.outerHTML ?? null})',
        returnByValue: true,
      });
      await writeFile(
        join(artifacts, 'page-state.json'),
        redactDiagnostic(state.result?.value ?? JSON.stringify(state))
      );
    });
    await capture('failure.html', async () =>
      writeFile(join(artifacts, 'failure.html'), redactDiagnostic(await html(session.cdp)))
    );
    await capture('failure.png', async () =>
      writeFile(
        join(artifacts, 'failure.png'),
        Buffer.from(await screenshot(session.cdp), 'base64')
      )
    );
  }
  await capture('launch-logs.json', () =>
    writeFile(
      join(artifacts, 'launch-logs.json'),
      JSON.stringify(
        redactDiagnostics(
          result.launches.map((entry) => ({ args: entry.args, logs: entry.logs() }))
        ),
        null,
        2
      )
    )
  );
  return { captureErrors, files };
}

export async function main() {
  const sandbox = await mkdtemp(join(tmpdir(), 'lightframe-e2e-'));
  const fixture = join(sandbox, 'fixture');
  const paths = {
    appData: join(sandbox, 'appdata'),
    localAppData: join(sandbox, 'localappdata'),
    userProfile: join(sandbox, 'userprofile'),
    temp: join(sandbox, 'temp'),
    webviewUserData: join(sandbox, 'webview2-user-data'),
  };
  const result = {
    startedAt: new Date().toISOString(),
    exe: basename(exe),
    journeys: [],
    launches: [],
  };
  let session;
  let failure;
  let failureArtifacts;
  const onOwned = (owned) => {
    session = owned;
  };
  try {
    await rm(artifacts, { recursive: true, force: true });
    await mkdir(artifacts, { recursive: true });
    await Promise.all(
      [fixture, ...Object.values(paths)].map((path) => mkdir(path, { recursive: true }))
    );
    await Promise.all(
      [1, 2, 3, 4].map((index) =>
        writeFile(join(fixture, `demo-${String(index).padStart(2, '0')}.png`), fixturePng)
      )
    );
    session = await launch([], paths, result.launches, { onOwned });
    await runHomeStartup(session, result);
    await closeOwnedSession(session);
    session = undefined;
    session = await launch(['--folder', fixture], paths, result.launches, { onOwned });
    await runFolderStartup(session, result);
    await runNavigationGrid(session, result);
    await runRapidOverlappingNavigation(session, result);
    await runCuration(session);
    await closeOwnedSession(session);
    session = undefined;
    session = await launch(['--folder', fixture], paths, result.launches, { onOwned });
    await runCurationPersistence(session, result);
    await runShortcutDialogs(session, result);
    if (fatalCdpEvents(session.cdp.events).length) throw new Error('CDP error after E2E journeys');
    result.completedAt = new Date().toISOString();
  } catch (error) {
    failure = error;
    failureArtifacts = await captureFailureArtifacts(session, result);
  }
  try {
    failure = await finalizeHarness(result, failure, session, sandbox);
  } catch (error) {
    failure = error;
  }
  if (failure) {
    const captured = failureArtifacts ?? (await captureFailureArtifacts(session, result));
    await writeFile(
      join(artifacts, 'failure.json'),
      JSON.stringify(redactedFailureReport(result, failure, captured), null, 2)
    );
    throw failure;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(failureConsoleMessage(error));
    process.exitCode = 1;
  });
}

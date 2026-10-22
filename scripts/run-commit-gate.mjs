import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const git = process.platform === 'win32' ? 'git.exe' : 'git';

// Hooks inherit repository-local Git variables. Forwarding them makes a test's
// `git init` target the enclosing repository instead of its disposable fixture.
export function gateEnvironment(environment = process.env) {
  const result = spawnSync(git, ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
    env: environment,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Unable to identify repository-local Git environment variables', {
      cause: result.error,
    });
  }
  const localKeys = new Set(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((key) => key.toUpperCase())
  );
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !localKeys.has(key.toUpperCase()) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(key)
    )
  );
}

function escapeWindowsShellArg(value) {
  if (value.length === 0) {
    return '""';
  }

  return /[\s"&<>^|]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function run(bin, args, label, options = {}) {
  console.log(`\n> ${label}`);
  const result =
    process.platform === 'win32'
      ? spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', [bin, ...args].map(escapeWindowsShellArg).join(' ')],
          {
            stdio: 'inherit',
            ...options,
          }
        )
      : spawnSync(bin, args, {
          stdio: 'inherit',
          ...options,
        });

  if (result.error) {
    console.error(`${label} failed: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureOriginMain(environment) {
  const verify = spawnSync(git, ['rev-parse', '--verify', 'origin/main'], {
    stdio: 'ignore',
    env: environment,
  });
  if (verify.status === 0) {
    return;
  }

  run(git, ['fetch', 'origin', 'main', '--quiet'], 'Fetch origin/main for changed-code audit', {
    env: environment,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const environment = gateEnvironment();
  ensureOriginMain(environment);
  run('pnpm', ['run', 'ci:frontend'], 'Run commit gate', { env: environment });
}

import { spawnSync } from 'node:child_process';

const git = process.platform === 'win32' ? 'git.exe' : 'git';

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

function ensureOriginMain() {
  const verify = spawnSync(git, ['rev-parse', '--verify', 'origin/main'], { stdio: 'ignore' });
  if (verify.status === 0) {
    return;
  }

  run(git, ['fetch', 'origin', 'main', '--quiet'], 'Fetch origin/main for changed-code audit');
}

ensureOriginMain();
run('pnpm', ['run', 'ci:frontend'], 'Run commit gate');

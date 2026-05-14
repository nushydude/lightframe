import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const gitDir = path.join(repoRoot, '.git');

if (!existsSync(gitDir)) {
  process.exit(0);
}

const git = process.platform === 'win32' ? 'git.exe' : 'git';
const result = spawnSync(git, ['config', 'core.hooksPath', '.githooks'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.warn('Failed to configure core.hooksPath:', result.error.message);
  process.exit(0);
}

process.exit(result.status ?? 0);

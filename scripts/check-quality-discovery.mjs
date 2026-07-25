import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-quality-discovery-'));

try {
  const currentTest = path.join(temporaryRoot, 'src', 'sentinel.test.ts');
  const siblingTest = path.join(temporaryRoot, '.worktrees', 'sibling', 'src', 'sentinel.test.ts');
  await fs.mkdir(path.dirname(currentTest), { recursive: true });
  await fs.mkdir(path.dirname(siblingTest), { recursive: true });
  await fs.writeFile(currentTest, 'export const included = true;\n');
  await fs.writeFile(siblingTest, 'export const excluded = true;\n');

  const testInclude = /^src\/.*\.(?:test|spec)\.(?:ts|tsx)$/;
  const worktreeExclude = /(?:^|[\\/])\.worktrees(?:[\\/]|$)/;
  const relativeCurrent = path.relative(temporaryRoot, currentTest).replaceAll('\\', '/');
  const relativeSibling = path.relative(temporaryRoot, siblingTest).replaceAll('\\', '/');
  assert.match(relativeCurrent, testInclude);
  assert.doesNotMatch(relativeCurrent, worktreeExclude);
  assert.doesNotMatch(relativeSibling, testInclude);
  assert.match(relativeSibling, worktreeExclude);

  const eslintConfig = await fs.readFile(path.join(root, 'eslint.config.js'), 'utf8');
  const viteConfig = await fs.readFile(path.join(root, 'vite.config.ts'), 'utf8');
  const prettierIgnore = await fs.readFile(path.join(root, '.prettierignore'), 'utf8');
  const fallowConfig = await fs.readFile(path.join(root, '.fallowrc.json'), 'utf8');
  for (const config of [eslintConfig, viteConfig, prettierIgnore, fallowConfig]) {
    assert.match(config, /\.worktrees/);
  }
  console.log('quality discovery sentinel checks passed');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

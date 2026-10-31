import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gateEnvironment } from '../run-commit-gate.mjs';

test('gate clears inherited hook Git context so fixture operations cannot mutate the enclosing repository', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lightframe-gate-env-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('lightframe-gate-env-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const parent = path.join(root, 'parent');
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(parent);
  fs.mkdirSync(fixture);
  const baselineEnvironment = gateEnvironment();
  const git = (cwd, environment, ...args) =>
    execFileSync('git', args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(parent, baselineEnvironment, 'init', '-q');
  const parentGit = path.join(parent, '.git');
  const configBefore = fs.readFileSync(path.join(parentGit, 'config'), 'utf8');
  const inherited = {
    ...baselineEnvironment,
    GIT_DIR: parentGit,
    GIT_COMMON_DIR: parentGit,
    GIT_WORK_TREE: parent,
    GIT_IMPLICIT_WORK_TREE: '0',
    GIT_INDEX_FILE: path.join(parentGit, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(parentGit, 'objects'),
    GIT_PREFIX: 'inherited/',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_PARAMETERS: "'core.bare=true'",
    GIT_AUTHOR_NAME: 'Preserved identity',
    LIGHTFRAME_TEST_VALUE: 'preserved',
  };
  const sanitized = gateEnvironment(inherited);
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_PARAMETERS',
  ])
    assert.equal(sanitized[key], undefined, key);
  assert.equal(sanitized.PATH, inherited.PATH);
  assert.equal(sanitized.GIT_AUTHOR_NAME, 'Preserved identity');
  assert.equal(sanitized.LIGHTFRAME_TEST_VALUE, 'preserved');
  git(fixture, sanitized, 'init', '-q');
  fs.writeFileSync(path.join(fixture, 'fixture.txt'), 'fixture');
  git(fixture, sanitized, 'add', 'fixture.txt');
  assert.equal(git(fixture, sanitized, 'ls-files'), 'fixture.txt');
  assert.equal(git(parent, baselineEnvironment, 'ls-files'), '');
  assert.equal(fs.existsSync(path.join(parentGit, 'index')), false);
  assert.equal(fs.readFileSync(path.join(parentGit, 'config'), 'utf8'), configBefore);
  assert.equal(git(parent, baselineEnvironment, 'config', '--bool', 'core.bare'), 'false');
  assert.equal(inherited.GIT_DIR, parentGit);
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../agent-task.mjs');
const roots = [];
const slug = 'fixture-task';

function fixture(phase = 'IMPLEMENTING') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lightframe-agent-task-'));
  roots.push(root);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Agent Task Test');
  git('config', 'user.email', 'agent-task@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(source, path.join(root, 'scripts/agent-task.mjs'));
  fs.writeFileSync(path.join(root, '.gitignore'), '.worktrees/\n.agent/runtime/\n');
  fs.writeFileSync(path.join(root, 'changed.txt'), 'baseline');
  fs.writeFileSync(path.join(root, 'deleted.txt'), 'delete me');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const baseSha = git('rev-parse', 'HEAD');
  const worktree = path.join(root, '.worktrees', slug);
  git('worktree', 'add', '-b', `codex/${slug}`, worktree);
  fs.writeFileSync(path.join(worktree, 'changed.txt'), 'updated');
  fs.unlinkSync(path.join(worktree, 'deleted.txt'));
  fs.writeFileSync(path.join(worktree, 'new file.txt'), 'untracked');
  const stateFile = path.join(root, '.agent/runtime', slug, 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const state = {
    version: 1,
    slug,
    phase,
    branch: `codex/${slug}`,
    baseSha,
    worktree,
    reviewCycles: 0,
    history: [{ phase, note: 'fixture' }],
    pr: { number: 12, headSha: baseSha },
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const run = (...args) => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/agent-task.mjs'), ...args, '--slug', slug],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, AGENT_TASK_RUNTIME_ROOT: path.dirname(path.dirname(stateFile)) },
      }
    );
    return { ...result, json: result.status === 0 ? JSON.parse(result.stdout) : null };
  };
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const save = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
  const freeze = () => {
    if (read().phase === 'IMPLEMENTING')
      assert.equal(run('transition', '--to', 'LOCAL_CHECKS').status, 0);
    const result = run('freeze', '--checks', 'focused,ci:local');
    assert.equal(result.status, 0, result.stderr);
    return result.json;
  };
  const evidence = (candidate, result = 'passed', check = 'ci:local') =>
    run(
      'record-evidence',
      '--candidate-id',
      candidate.id,
      '--check',
      check,
      '--command',
      `pnpm run ${check}`,
      '--result',
      result
    );
  const checked = () => {
    const candidate = freeze();
    assert.equal(evidence(candidate).status, 0);
    assert.equal(evidence(candidate, 'passed', 'focused').status, 0);
    assert.equal(run('transition', '--to', 'REVIEWING').status, 0);
    return candidate;
  };
  return { root, git, worktree, stateFile, run, read, save, freeze, evidence, checked };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('lightframe-agent-task-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy recovery preserves history and PR metadata but invalidates delivery approval', () => {
  for (const phase of ['REVIEWING', 'PR_READY', 'AUTHORIZATION_REQUIRED', 'REMEDIATING_REVIEW']) {
    const f = fixture(phase);
    f.save({ ...f.read(), review: { status: 'APPROVED', summary: 'legacy' } });
    const result = f.run('show');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.version, 2);
    assert.equal(result.json.phase, 'LOCAL_CHECKS');
    assert.equal(result.json.review, null);
    assert.equal(result.json.reviewHistory[0].stale, true);
    assert.equal(result.json.pr.number, 12);
    assert.equal(result.json.history[0].note, 'fixture');
    assert.equal(f.run('transition', '--to', 'REVIEWING').status, 1);
    assert.deepEqual(f.run('show').json, result.json);
  }
});

test('candidate covers edits, deletions, untracked files, required checks, review, and post-review mutations', () => {
  const f = fixture();
  const candidate = f.freeze();
  assert.deepEqual(
    candidate.files.map(({ path: name, state }) => [name, state]),
    [
      ['changed.txt', 'present'],
      ['deleted.txt', 'deleted'],
      ['new file.txt', 'present'],
    ]
  );
  assert.equal(f.run('transition', '--to', 'REVIEWING').status, 1);
  assert.equal(f.evidence(candidate).status, 0);
  assert.equal(f.evidence(candidate, 'failed', 'focused').status, 0);
  assert.equal(f.run('transition', '--to', 'REVIEWING').status, 1);
  assert.equal(f.evidence(candidate, 'passed', 'focused').status, 0);
  assert.equal(f.run('transition', '--to', 'REVIEWING').status, 0);
  assert.equal(f.run('transition', '--to', 'REMEDIATING_REVIEW').status, 1);
  assert.equal(f.run('record-review', '--status', 'APPROVED').status, 1);
  assert.equal(f.run('record-review', '--candidate-id', 'wrong', '--status', 'APPROVED').status, 1);
  assert.equal(
    f.run('record-review', '--candidate-id', candidate.id, '--status', 'APPROVED').status,
    0
  );
  assert.equal(f.run('transition', '--to', 'AUTHORIZATION_REQUIRED').status, 0);
  assert.equal(
    f.run('transition', '--to', 'PR_READY', '--review-approved', '--local-gates-pass').status,
    1
  );
  fs.appendFileSync(path.join(f.worktree, 'new file.txt'), 'post-review change');
  const readyArgs = [
    'transition',
    '--to',
    'PR_READY',
    '--review-approved',
    '--local-gates-pass',
    '--delivery-authorized',
  ];
  assert.match(f.run(...readyArgs).stderr, /changed after candidate freeze/);
  assert.equal(f.run('transition', '--to', 'LOCAL_CHECKS').status, 0);
  const next = f.freeze();
  assert.notEqual(next.id, candidate.id);
  assert.deepEqual(f.read().evidence, []);
  assert.equal(f.read().review, null);
  assert.equal(f.read().reviewHistory.at(-1).stale, true);
  assert.equal(f.evidence(candidate).status, 1);
});

test('committing identical frozen content preserves identity and record-pr refuses changed content', () => {
  const f = fixture();
  const candidate = f.checked();
  assert.equal(
    f.run('record-review', '--candidate-id', candidate.id, '--status', 'APPROVED').status,
    0
  );
  f.git('-C', f.worktree, 'add', '.');
  f.git('-C', f.worktree, 'commit', '-qm', 'candidate');
  assert.equal(
    f.run(
      'transition',
      '--to',
      'PR_READY',
      '--review-approved',
      '--local-gates-pass',
      '--delivery-authorized'
    ).status,
    0
  );
  fs.appendFileSync(path.join(f.worktree, 'changed.txt'), 'late edit');
  assert.equal(
    f.run(
      'record-pr',
      '--number',
      '3',
      '--url',
      'https://example.invalid/3',
      '--head-sha',
      f.git('-C', f.worktree, 'rev-parse', 'HEAD')
    ).status,
    1
  );
  fs.writeFileSync(path.join(f.worktree, 'changed.txt'), 'updated');
  assert.equal(
    f.run(
      'record-pr',
      '--number',
      '3',
      '--url',
      'https://example.invalid/3',
      '--head-sha',
      'wrong-head'
    ).status,
    1
  );
  const head = f.git('-C', f.worktree, 'rev-parse', 'HEAD');
  const recorded = f.run(
    'record-pr',
    '--number',
    '3',
    '--url',
    'https://example.invalid/3',
    '--head-sha',
    head
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(recorded.json.pr.headSha, head);
});

test('three unchanged review findings stop the loop; a changed candidate resets only the unchanged count', () => {
  const f = fixture();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const candidate = f.checked();
    assert.equal(
      f.run(
        'record-review',
        '--candidate-id',
        candidate.id,
        '--status',
        'CHANGES_REQUESTED',
        '--summary',
        'same issue'
      ).status,
      0
    );
    assert.equal(f.run('transition', '--to', 'LOCAL_CHECKS').status, 0);
  }
  const candidate = f.freeze();
  f.evidence(candidate);
  f.evidence(candidate, 'passed', 'focused');
  assert.match(f.run('transition', '--to', 'REVIEWING').stderr, /three unchanged review cycles/);
  fs.appendFileSync(path.join(f.worktree, 'changed.txt'), 'repair');
  f.freeze();
  assert.equal(f.read().unchangedReviewCycles, 0);
  assert.equal(f.read().reviewCycles, 3);
});

test('bootstrap refuses dirty source without changing user files or creating state', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'user.txt'), 'preserve');
  const result = spawnSync(
    process.execPath,
    [path.join(f.root, 'scripts/agent-task.mjs'), 'start', '--slug', 'new-task', '--title', 'test'],
    { cwd: f.root, encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source checkout is not clean/);
  assert.equal(fs.readFileSync(path.join(f.root, 'user.txt'), 'utf8'), 'preserve');
  assert.equal(fs.existsSync(path.join(f.root, '.worktrees/new-task')), false);
});

test('required scope gate cannot be omitted and unsupported state versions are preserved', () => {
  const f = fixture('LOCAL_CHECKS');
  assert.equal(f.run('freeze', '--checks', 'focused').status, 1);
  f.save({ ...f.read(), version: 99 });
  assert.match(f.run('show').stderr, /unsupported task state version/);
  assert.equal(f.read().version, 99);
});

test('close requires confirmation, rejects dirty or mismatched checkout, and preserves branch and runtime', () => {
  const f = fixture('DONE');
  assert.equal(f.run('close').status, 1);
  assert.match(f.run('close', '--merged').stderr, /dirty/);
  const state = f.read();
  f.save({ ...state, worktree: f.root });
  assert.match(f.run('close', '--merged').stderr, /identity mismatch/);
  f.save(state);
  f.git('-C', f.worktree, 'add', '.');
  f.git('-C', f.worktree, 'commit', '-qm', 'finished');
  const closed = f.run('close', '--merged');
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(closed.json.phase, 'CLOSED');
  assert.equal(fs.existsSync(f.worktree), false);
  assert.ok(f.git('show-ref', '--verify', `refs/heads/codex/${slug}`));
  assert.ok(fs.existsSync(f.stateFile));
});

test('partial Windows removal recovery never deletes an unregistered leftover checkout or falsely closes it', () => {
  const f = fixture('DONE');
  // Model Git having unregistered a worktree while source and dependencies remain.
  fs.unlinkSync(path.join(f.worktree, '.git'));
  f.git('worktree', 'prune', '--expire', 'now');
  fs.mkdirSync(path.join(f.worktree, 'node_modules'));
  fs.writeFileSync(path.join(f.worktree, 'node_modules/keep.txt'), 'dependency');
  for (let retry = 0; retry < 2; retry += 1) {
    const result = f.run('close', '--merged');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(f.worktree));
    assert.equal(f.read().phase, 'CLEANUP_PENDING');
    assert.equal(fs.readFileSync(path.join(f.worktree, 'changed.txt'), 'utf8'), 'updated');
    assert.equal(
      fs.readFileSync(path.join(f.worktree, 'node_modules/keep.txt'), 'utf8'),
      'dependency'
    );
  }
  // A human has preserved and removed the leftovers. Recovery can now finish.
  const moved = path.join(f.root, 'preserved-checkout');
  fs.renameSync(f.worktree, moved);
  assert.equal(f.run('close', '--merged').json.phase, 'CLOSED');
  assert.equal(fs.readFileSync(path.join(moved, 'changed.txt'), 'utf8'), 'updated');
});

test('failed registered removal persists cleanup intent and can be retried without deleting user data', () => {
  const f = fixture('DONE');
  f.git('-C', f.worktree, 'add', '.');
  f.git('-C', f.worktree, 'commit', '-qm', 'finished');
  f.git('worktree', 'lock', f.worktree);
  const failed = f.run('close', '--merged');
  assert.equal(failed.status, 1);
  assert.equal(f.read().phase, 'CLEANUP_PENDING');
  assert.ok(failed.stderr.includes(f.worktree));
  assert.equal(fs.readFileSync(path.join(f.worktree, 'changed.txt'), 'utf8'), 'updated');
  f.git('worktree', 'unlock', f.worktree);
  assert.equal(f.run('close', '--merged').json.phase, 'CLOSED');
});

test('close refuses a registered path whose Git identity was replaced', () => {
  const f = fixture('DONE');
  fs.unlinkSync(path.join(f.worktree, '.git'));
  fs.writeFileSync(
    path.join(f.worktree, '.git'),
    `gitdir: ${path.join(f.root, '.git').replaceAll('\\', '/')}\n`
  );
  const result = f.run('close', '--merged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /branch identity mismatch/);
  assert.equal(fs.readFileSync(path.join(f.worktree, 'changed.txt'), 'utf8'), 'updated');
  assert.equal(f.read().phase, 'DONE');
});

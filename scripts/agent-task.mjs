#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(repoRoot, '.agent', 'runtime');
const worktreeRoot = path.join(repoRoot, '.worktrees');

const transitions = {
  TASK_SELECTED: ['SPECIFYING', 'BLOCKED_DIRTY_WORKTREE'],
  SPECIFYING: ['BRANCH_READY', 'AUTHORIZATION_REQUIRED'],
  BLOCKED_DIRTY_WORKTREE: ['BRANCH_READY', 'ABANDONED'],
  BRANCH_READY: ['IMPLEMENTING'],
  IMPLEMENTING: ['IMPLEMENTATION_FAILED', 'LOCAL_CHECKS'],
  IMPLEMENTATION_FAILED: ['IMPLEMENTING', 'ABANDONED'],
  LOCAL_CHECKS: ['REMEDIATING_LOCAL_FAILURES', 'REVIEWING'],
  REMEDIATING_LOCAL_FAILURES: ['LOCAL_CHECKS'],
  REVIEWING: ['REMEDIATING_REVIEW', 'PR_READY', 'AUTHORIZATION_REQUIRED'],
  REMEDIATING_REVIEW: ['REVIEWING'],
  AUTHORIZATION_REQUIRED: ['PR_READY', 'ABANDONED'],
  PR_READY: ['PIPELINE_WAIT'],
  PIPELINE_WAIT: ['PIPELINE_REMEDIATION', 'DONE'],
  PIPELINE_REMEDIATION: ['PIPELINE_WAIT'],
  DONE: [],
  ABANDONED: [],
};

function usage() {
  console.log(`Usage:
  node scripts/agent-task.mjs start --slug <slug> --title <title> [--spec-file <path>] [--base origin/main]
  node scripts/agent-task.mjs show --slug <slug>
  node scripts/agent-task.mjs transition --slug <slug> --to <state> [--note <text>]
  node scripts/agent-task.mjs record-review --slug <slug> --status APPROVED|CHANGES_REQUESTED [--summary <text>]
  node scripts/agent-task.mjs record-pr --slug <slug> --number <n> --url <url> --head-sha <sha>
  node scripts/agent-task.mjs close --slug <slug> --merged

The start command creates an isolated codex/<slug> worktree from freshly fetched origin/main.
State is stored locally under .agent/runtime/<slug>/state.json.`);
}

function argsFrom(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._ ??= [];
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

function git(argumentsList, cwd = repoRoot) {
  return execFileSync('git', argumentsList, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(message) {
  console.error(`agent-task: ${message}`);
  process.exitCode = 1;
}

function requireSlug(slug) {
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('--slug must contain lowercase letters, numbers, and single hyphens only');
  }
}

function statePath(slug) {
  return path.join(runtimeRoot, slug, 'state.json');
}

function readState(slug) {
  requireSlug(slug);
  const file = statePath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`no state exists for '${slug}'`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeState(state) {
  const file = statePath(state.slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function now() {
  return new Date().toISOString();
}

function assertCleanSource() {
  if (git(['status', '--porcelain'])) {
    throw new Error(
      'source checkout is not clean; preserve the existing changes and start from a clean checkout'
    );
  }
}

function assertRefFree(ref, message) {
  try {
    git(['show-ref', '--verify', '--quiet', ref]);
  } catch (error) {
    if (error.status === 1) return;
    throw error;
  }
  throw new Error(message);
}

function assertBranchFree(branch) {
  assertRefFree('refs/heads/' + branch, "local branch '" + branch + "' already exists");
  assertRefFree(
    'refs/remotes/origin/' + branch,
    "remote branch 'origin/" + branch + "' already exists"
  );
}

function specificationMetadata(specification) {
  if (!specification) return null;
  return {
    source: specification,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(specification)).digest('hex'),
  };
}

function createState({ slug, title, specification, base, baseSha, branch, worktree, timestamp }) {
  return {
    version: 1,
    slug,
    title,
    specification: specificationMetadata(specification),
    base,
    baseSha,
    branch,
    worktree,
    phase: 'BRANCH_READY',
    reviewCycles: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [
      { phase: 'TASK_SELECTED', at: timestamp, note: 'Task state created' },
      {
        phase: 'BRANCH_READY',
        at: timestamp,
        note: 'Created from ' + base + ' at ' + baseSha,
      },
    ],
  };
}

function requireFlag(args, flag, message) {
  if (!args[flag]) throw new Error(message);
}

function validateTransition(state, target, args) {
  if (!target || target === true) throw new Error('--to is required');
  if (!transitions[state.phase]?.includes(target)) {
    throw new Error('invalid transition ' + state.phase + ' -> ' + target);
  }
  if (target !== 'PR_READY') return;
  requireFlag(args, 'review-approved', 'PR_READY requires --review-approved');
  requireFlag(args, 'local-gates-pass', 'PR_READY requires --local-gates-pass');
  requireFlag(
    args,
    'delivery-authorized',
    'PR_READY requires explicit delivery authorization: --delivery-authorized'
  );
  if (state.review?.status !== 'APPROVED') {
    throw new Error('PR_READY requires a recorded independent APPROVED review');
  }
}

function validateStartArgs(args) {
  const slug = args.slug;
  const title = args.title;
  const base = args.base || 'origin/main';
  const specification = args['spec-file'] ? path.resolve(args['spec-file']) : null;
  requireSlug(slug);
  if (!title || title === true) throw new Error('--title is required');
  if (specification && !fs.existsSync(specification))
    throw new Error(`specification file not found: ${specification}`);
  if (fs.existsSync(statePath(slug))) throw new Error(`task state already exists for '${slug}'`);
  return { slug, title, base, specification };
}

function prepareStart({ slug, base }) {
  assertCleanSource();
  git(['fetch', 'origin', 'main']);
  const baseSha = git(['rev-parse', `${base}^{commit}`]);
  const branch = `codex/${slug}`;
  assertBranchFree(branch);
  const worktree = path.join(worktreeRoot, slug);
  if (fs.existsSync(worktree)) throw new Error(`worktree path already exists: ${worktree}`);
  fs.mkdirSync(worktreeRoot, { recursive: true });
  return { baseSha, branch, worktree };
}

function start(args) {
  const { slug, title, base, specification } = validateStartArgs(args);
  const { baseSha, branch, worktree } = prepareStart({ slug, base });
  git(['worktree', 'add', '-b', branch, worktree, base]);

  const timestamp = now();
  const state = createState({
    slug,
    title,
    specification,
    base,
    baseSha,
    branch,
    worktree,
    timestamp,
  });
  writeState(state);
  console.log(
    JSON.stringify({ slug, branch, base, baseSha, worktree, phase: 'BRANCH_READY' }, null, 2)
  );
}

function transition(args) {
  const state = readState(args.slug);
  const target = args.to;
  validateTransition(state, target, args);
  const timestamp = now();
  state.phase = target;
  state.updatedAt = timestamp;
  state.history.push({ phase: target, at: timestamp, note: args.note || '' });
  if (target === 'REVIEWING') state.reviewCycles += 1;
  if (state.reviewCycles > 3) throw new Error('maximum of three review cycles exceeded');
  writeState(state);
  console.log(JSON.stringify(state, null, 2));
}

function recordReview(args) {
  const state = readState(args.slug);
  if (state.phase !== 'REVIEWING')
    throw new Error('review results can only be recorded from REVIEWING');
  const status = args.status;
  if (status !== 'APPROVED' && status !== 'CHANGES_REQUESTED') {
    throw new Error('--status must be APPROVED or CHANGES_REQUESTED');
  }
  const timestamp = now();
  state.review = { status, summary: args.summary || '', at: timestamp };
  if (status === 'CHANGES_REQUESTED') {
    state.phase = 'REMEDIATING_REVIEW';
  }
  state.updatedAt = timestamp;
  state.history.push({ phase: state.phase, at: timestamp, note: `Reviewer status: ${status}` });
  writeState(state);
  console.log(JSON.stringify(state, null, 2));
}

function recordPr(args) {
  const state = readState(args.slug);
  if (state.phase !== 'PR_READY') throw new Error('PR metadata can only be recorded from PR_READY');
  if (!args.number || !args.url || !args['head-sha']) {
    throw new Error('--number, --url, and --head-sha are required');
  }
  const timestamp = now();
  state.pr = { number: Number(args.number), url: args.url, headSha: args['head-sha'] };
  state.phase = 'PIPELINE_WAIT';
  state.updatedAt = timestamp;
  state.history.push({ phase: 'PIPELINE_WAIT', at: timestamp, note: `PR ${args.url}` });
  writeState(state);
  console.log(JSON.stringify(state, null, 2));
}

function closeTask(args) {
  const state = readState(args.slug);
  if (state.phase !== 'DONE') throw new Error('task can only be closed from DONE');
  if (!args.merged) throw new Error('closing a task requires --merged');
  const status = git(['-C', state.worktree, 'status', '--porcelain']);
  if (status) throw new Error('task worktree is dirty; refusing to remove it');
  git(['worktree', 'remove', state.worktree]);
  state.phase = 'CLOSED';
  state.updatedAt = now();
  state.history.push({
    phase: 'CLOSED',
    at: state.updatedAt,
    note: 'Merged task worktree removed',
  });
  writeState(state);
  console.log(JSON.stringify(state, null, 2));
}

try {
  const args = argsFrom(process.argv.slice(2));
  const command = args._?.[0];
  if (!command || command === 'help' || args.help) {
    usage();
  } else if (command === 'start') {
    start(args);
  } else if (command === 'show') {
    console.log(JSON.stringify(readState(args.slug), null, 2));
  } else if (command === 'transition') {
    transition(args);
  } else if (command === 'record-review') {
    recordReview(args);
  } else if (command === 'record-pr') {
    recordPr(args);
  } else if (command === 'close') {
    closeTask(args);
  } else {
    throw new Error(`unknown command '${command}'`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

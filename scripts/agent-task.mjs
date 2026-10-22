#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = process.env.AGENT_TASK_RUNTIME_ROOT || path.join(repoRoot, '.agent', 'runtime');
const worktreeRoot = path.join(repoRoot, '.worktrees');
const stateVersion = 2;

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
  REMEDIATING_REVIEW: ['LOCAL_CHECKS'],
  AUTHORIZATION_REQUIRED: ['PR_READY', 'LOCAL_CHECKS', 'ABANDONED'],
  PR_READY: ['PIPELINE_WAIT', 'LOCAL_CHECKS'],
  PIPELINE_WAIT: ['PIPELINE_REMEDIATION', 'DONE'],
  PIPELINE_REMEDIATION: ['LOCAL_CHECKS'],
  DONE: [],
  CLEANUP_PENDING: [],
  CLOSED: [],
  ABANDONED: [],
};

function usage() {
  console.log(`Usage:
  node scripts/agent-task.mjs start --slug <slug> --title <title> [--spec-file <path>] [--base origin/main]
  node scripts/agent-task.mjs show --slug <slug>
  node scripts/agent-task.mjs transition --slug <slug> --to <state> [--note <text>]
  node scripts/agent-task.mjs freeze --slug <slug> --checks <comma-separated-required-checks>
  node scripts/agent-task.mjs record-evidence --slug <slug> --candidate-id <sha> --check <name> --command <command> --result passed|failed|skipped|blocked
  node scripts/agent-task.mjs record-review --slug <slug> --candidate-id <sha> --status APPROVED|CHANGES_REQUESTED [--summary <text>]
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
  return gitRaw(argumentsList, cwd).trim();
}

function gitRaw(argumentsList, cwd = repoRoot) {
  return execFileSync('git', argumentsList, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.slug !== slug) throw new Error('task state slug does not match requested task');
  if (state.version === stateVersion) return state;
  if (state.version !== 1) throw new Error(`unsupported task state version '${state.version}'`);
  // Preserve history/PR metadata, but never treat an unbound legacy approval as current.
  if (state.review)
    state.reviewHistory = [...(state.reviewHistory || []), { ...state.review, stale: true }];
  state.review = null;
  state.candidate = null;
  state.evidence = [];
  state.unchangedReviewCycles = 0;
  if (
    [
      'REVIEWING',
      'PR_READY',
      'AUTHORIZATION_REQUIRED',
      'REMEDIATING_REVIEW',
      'REMEDIATING_LOCAL_FAILURES',
    ].includes(state.phase)
  )
    state.phase = 'LOCAL_CHECKS';
  state.version = stateVersion;
  state.migration = { fromVersion: 1, at: now() };
  writeState(state);
  return state;
}

function writeState(state) {
  const file = statePath(state.slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
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
    version: stateVersion,
    slug,
    title,
    specification: specificationMetadata(specification),
    base,
    baseSha,
    branch,
    worktree,
    phase: 'BRANCH_READY',
    reviewCycles: 0,
    unchangedReviewCycles: 0,
    candidate: null,
    evidence: [],
    review: null,
    reviewHistory: [],
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
  if (args[flag] !== true) throw new Error(message);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function candidateFileMode(stat, relative, fileMode, indexModes) {
  if (!fileMode) return indexModes.get(relative) || '100644';
  return stat.mode & 0o111 ? '100755' : '100644';
}

function candidateFile(worktree, relative, fileMode, indexModes) {
  const file = path.resolve(worktree, relative);
  if (!file.startsWith(worktree + path.sep)) throw new Error('candidate path escapes worktree');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { path: relative, state: 'deleted' };
  }
  if (stat.isSymbolicLink())
    return { path: relative, state: 'symlink', sha256: digest(fs.readlinkSync(file)) };
  if (!fs.realpathSync(file).startsWith(worktree + path.sep) || !stat.isFile())
    throw new Error(`unsafe candidate file: ${relative}`);
  const mode = candidateFileMode(stat, relative, fileMode, indexModes);
  return { path: relative, state: 'present', mode, sha256: digest(fs.readFileSync(file)) };
}

function candidateContent(state) {
  const worktree = fs.realpathSync(state.worktree);
  const indexModes = new Map(
    gitRaw(['ls-files', '--stage', '-z'], worktree)
      .split('\0')
      .filter(Boolean)
      .map((entry) => [entry.slice(entry.indexOf('\t') + 1), entry.slice(0, 6)])
  );
  const fileMode = git(['config', '--bool', 'core.filemode'], worktree) === 'true';
  const paths = [
    ...new Set(
      [
        ...gitRaw(['diff', '--no-renames', '--name-only', '-z', state.baseSha], worktree).split(
          '\0'
        ),
        ...gitRaw(['ls-files', '--others', '--exclude-standard', '-z'], worktree).split('\0'),
      ].filter(Boolean)
    ),
  ].sort();
  if (!paths.length) throw new Error('candidate has no changed files');
  const files = paths.map((relative) => candidateFile(worktree, relative, fileMode, indexModes));
  return { files, id: digest(JSON.stringify({ baseSha: state.baseSha, files })) };
}

function assertCandidate(state, candidateId) {
  if (!state.candidate || candidateId !== state.candidate.id)
    throw new Error('current frozen --candidate-id is required');
  if (candidateContent(state).id !== state.candidate.id)
    throw new Error(
      'worktree changed after candidate freeze; return to LOCAL_CHECKS and freeze again'
    );
}

function assertEvidence(state) {
  assertCandidate(state, state.candidate?.id);
  if (
    !state.candidate.checks.every((check) =>
      state.evidence.some(
        (item) =>
          item.candidateId === state.candidate.id &&
          item.check === check &&
          item.result === 'passed'
      )
    )
  )
    throw new Error('every required candidate check must pass');
}

function assertApproved(state) {
  assertEvidence(state);
  if (state.review?.status !== 'APPROVED' || state.review.candidateId !== state.candidate.id)
    throw new Error('recorded independent APPROVED review for current candidate is required');
}

function requiredChecks(value) {
  if (typeof value !== 'string') throw new Error('--checks is required');
  const checks = [
    ...new Set(
      value
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ].sort();
  if (!checks.length)
    throw new Error('--checks must name required checks, including the final scope gate');
  if (!checks.some((check) => ['ci:frontend', 'ci:rust', 'ci:local'].includes(check)))
    throw new Error('--checks must include ci:frontend, ci:rust, or ci:local');
  return checks;
}

function archiveReview(state, stale = false) {
  if (!state.review) return;
  const review = { ...state.review };
  if (stale) review.stale = true;
  state.reviewHistory = [...(state.reviewHistory || []), review];
}

function freeze(args) {
  const state = readState(args.slug);
  if (state.phase !== 'LOCAL_CHECKS') throw new Error('freeze requires LOCAL_CHECKS');
  const checks = requiredChecks(args.checks);
  const content = candidateContent(state);
  archiveReview(state, true);
  if (state.candidate?.id !== content.id) state.unchangedReviewCycles = 0;
  state.candidate = { ...content, checks, baseSha: state.baseSha, frozenAt: now() };
  state.review = null;
  state.evidence = [];
  state.updatedAt = now();
  writeState(state);
  console.log(JSON.stringify(state.candidate, null, 2));
}

function recordEvidence(args) {
  const state = readState(args.slug);
  if (state.phase !== 'LOCAL_CHECKS') throw new Error('evidence requires LOCAL_CHECKS');
  assertCandidate(state, args['candidate-id']);
  if (
    !state.candidate.checks.includes(args.check) ||
    typeof args.command !== 'string' ||
    !['passed', 'failed', 'skipped', 'blocked'].includes(args.result)
  )
    throw new Error('required --check, --command and valid --result are required');
  const item = {
    candidateId: state.candidate.id,
    check: args.check,
    command: args.command,
    result: args.result,
    details: args.details || '',
    at: now(),
  };
  state.evidence = state.evidence.filter((prior) => prior.check !== item.check);
  state.evidence.push(item);
  state.updatedAt = now();
  writeState(state);
  console.log(JSON.stringify(item, null, 2));
}

function requireDeliveryAuthorization(args) {
  requireFlag(args, 'review-approved', 'PR_READY requires --review-approved');
  requireFlag(args, 'local-gates-pass', 'PR_READY requires --local-gates-pass');
  requireFlag(
    args,
    'delivery-authorized',
    'PR_READY requires explicit delivery authorization: --delivery-authorized'
  );
}

function validateReviewEntry(state) {
  assertEvidence(state);
  if ((state.unchangedReviewCycles || 0) >= 3)
    throw new Error('three unchanged review cycles reached; ask user for direction');
}

function validateTransition(state, target, args) {
  if (!target || target === true) throw new Error('--to is required');
  if (!transitions[state.phase]?.includes(target)) {
    throw new Error('invalid transition ' + state.phase + ' -> ' + target);
  }
  if (target === 'REMEDIATING_REVIEW')
    throw new Error('use record-review to persist CHANGES_REQUESTED and count the review cycle');
  if (target === 'REVIEWING') validateReviewEntry(state);
  if (['AUTHORIZATION_REQUIRED', 'PR_READY'].includes(target)) assertApproved(state);
  if (target === 'PR_READY') requireDeliveryAuthorization(args);
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
  writeState(state);
  console.log(JSON.stringify(state, null, 2));
}

function recordReview(args) {
  const state = readState(args.slug);
  if (state.phase !== 'REVIEWING')
    throw new Error('review results can only be recorded from REVIEWING');
  const status = args.status;
  if (!['APPROVED', 'CHANGES_REQUESTED'].includes(status)) {
    throw new Error('--status must be APPROVED or CHANGES_REQUESTED');
  }
  assertCandidate(state, args['candidate-id']);
  const timestamp = now();
  archiveReview(state);
  state.review = {
    status,
    candidateId: state.candidate.id,
    summary: args.summary || '',
    at: timestamp,
  };
  if (status === 'CHANGES_REQUESTED') {
    state.unchangedReviewCycles = (state.unchangedReviewCycles || 0) + 1;
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
  assertApproved(state);
  if (!args.number || !args.url || !args['head-sha']) {
    throw new Error('--number, --url, and --head-sha are required');
  }
  if (
    git(['status', '--porcelain'], state.worktree) ||
    args['head-sha'] !== git(['rev-parse', 'HEAD'], state.worktree)
  )
    throw new Error('record-pr requires a clean committed candidate and its exact HEAD SHA');
  const timestamp = now();
  state.pr = { number: Number(args.number), url: args.url, headSha: args['head-sha'] };
  state.phase = 'PIPELINE_WAIT';
  state.updatedAt = timestamp;
  state.history.push({ phase: 'PIPELINE_WAIT', at: timestamp, note: `PR ${args.url}` });
  writeState(state);
  console.log(JSON.stringify(state, null, 2));
}

function cleanupTarget(state) {
  const commonDirectory = path.resolve(repoRoot, git(['rev-parse', '--git-common-dir']));
  const expected = path.join(path.dirname(commonDirectory), '.worktrees', state.slug);
  if (path.resolve(state.worktree) !== expected)
    throw new Error(`task worktree identity mismatch; expected ${expected}`);
  const target = expected;
  const runtimePath = fs.realpathSync(runtimeRoot);
  if (runtimePath === target || runtimePath.startsWith(target + path.sep))
    throw new Error(
      'runtime state is inside removal target; preserve it outside the task worktree first'
    );
  return { target, commonDirectory };
}

function matchesWorktreePath(line, target) {
  return line === `worktree ${target.replaceAll('\\', '/')}` || line === `worktree ${target}`;
}

function registeredWorktree(target) {
  return git(['worktree', 'list', '--porcelain'])
    .split(/\r?\n\r?\n/)
    .find((item) => matchesWorktreePath(item.split(/\r?\n/)[0], target));
}

function assertRegisteredIdentity(state, target, commonDirectory, entry) {
  const actualCommonDirectory = path.resolve(
    target,
    git(['rev-parse', '--git-common-dir'], target)
  );
  if (
    !entry.split(/\r?\n/).includes(`branch refs/heads/${state.branch}`) ||
    state.branch !== `codex/${state.slug}` ||
    fs.realpathSync(actualCommonDirectory) !== fs.realpathSync(commonDirectory) ||
    git(['symbolic-ref', '--quiet', 'HEAD'], target) !== `refs/heads/${state.branch}`
  )
    throw new Error('registered task branch identity mismatch');
  if (git(['status', '--porcelain'], target))
    throw new Error('task worktree is dirty; refusing to remove it');
}

function assertRemovalTarget(state, target, commonDirectory, entry) {
  if (!fs.existsSync(target)) return;
  if (
    fs.lstatSync(target).isSymbolicLink() ||
    fs.realpathSync(target) !==
      path.join(fs.realpathSync(path.dirname(commonDirectory)), '.worktrees', state.slug)
  )
    throw new Error('task worktree path is redirected; refusing removal');
  if (entry) assertRegisteredIdentity(state, target, commonDirectory, entry);
}

function markCleanupPending(state, target) {
  // Persist intent before Git runs: on Windows removal can unregister the worktree,
  // fail with Directory not empty, and leave source/dependencies behind.
  state.phase = 'CLEANUP_PENDING';
  state.cleanup = { path: target, at: now(), status: 'pending' };
  state.updatedAt = now();
  writeState(state);
}

function removeRegisteredWorktree(state, target) {
  try {
    git(['worktree', 'remove', target]);
  } catch (error) {
    state.cleanup.error = String(error.stderr || error.message).trim();
    writeState(state);
    throw new Error(
      `cleanup pending at ${target}: ${state.cleanup.error}; preserve remaining files and retry close after resolving them`,
      { cause: error }
    );
  }
}

function assertRemovalComplete(state, target) {
  if (fs.existsSync(target)) {
    state.cleanup.error =
      'directory remains without a registered task worktree; no files were deleted by recovery';
    writeState(state);
    throw new Error(
      `cleanup pending at ${target}: ${state.cleanup.error}; inspect and preserve remaining files before removing them`
    );
  }
  if (registeredWorktree(target)) throw new Error(`cleanup pending: Git still registers ${target}`);
}

function closeTask(args) {
  const state = readState(args.slug);
  if (!['DONE', 'CLEANUP_PENDING'].includes(state.phase))
    throw new Error('task can only be closed from DONE or CLEANUP_PENDING');
  requireFlag(args, 'merged', 'closing a task requires --merged after user merge confirmation');
  const { target, commonDirectory } = cleanupTarget(state);
  const entry = registeredWorktree(target);
  assertRemovalTarget(state, target, commonDirectory, entry);
  markCleanupPending(state, target);
  if (entry) removeRegisteredWorktree(state, target);
  assertRemovalComplete(state, target);
  state.phase = 'CLOSED';
  state.cleanup.status = 'complete';
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
  } else if (command === 'freeze') {
    freeze(args);
  } else if (command === 'record-evidence') {
    recordEvidence(args);
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

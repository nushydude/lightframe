import { readFileSync } from 'node:fs';

const allowedTypes = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const conventionalCommitPattern = new RegExp(
  `^(?:${allowedTypes.join('|')})(?:\\([a-z0-9./_-]+\\))?!?: .+$`
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const scriptArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const commitMessagePath = scriptArgs[0];
if (!commitMessagePath) {
  fail('Missing commit message file path.');
}

const rawMessage = readFileSync(commitMessagePath, 'utf8');
const firstLine = rawMessage
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .find((line) => line.length > 0);

if (!firstLine) {
  fail('Commit message cannot be empty.');
}

const bypassPatterns = [/^Merge\b/u, /^Revert\b/u, /^(?:fixup|squash)! /u];
if (bypassPatterns.some((pattern) => pattern.test(firstLine))) {
  process.exit(0);
}

if (!conventionalCommitPattern.test(firstLine)) {
  fail(
    [
      `Invalid commit message: "${firstLine}"`,
      'Expected Conventional Commits, for example:',
      '  feat(viewer): add zoom preset toggle',
      '  fix(cache)!: invalidate stale preview entries',
      'Allowed types:',
      `  ${allowedTypes.join(', ')}`,
    ].join('\n')
  );
}

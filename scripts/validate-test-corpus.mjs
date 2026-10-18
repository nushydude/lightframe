import { createHash } from 'node:crypto';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({
  manifest: 256 * 1024,
  file: 8 * 1024 * 1024,
  total: 24 * 1024 * 1024,
  fixtures: 64,
});
export const FAMILIES = Object.freeze([
  'raf',
  'tiff',
  'cr3',
  'jpeg',
  'jxl',
  'psd',
  'heif',
  'xmp',
  'colour',
]);
const root = path.resolve(import.meta.dirname, '..', 'test-corpus');
const fail = (message) => {
  throw new Error(`test corpus: ${message}`);
};
const requireThat = (condition, message) => {
  if (!condition) fail(message);
};
const nonempty = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Use one portable path grammar even when the validator is running on POSIX.
export function safeRelative(value) {
  requireThat(
    typeof value === 'string' && value.length <= 240 && /^[a-zA-Z0-9_./-]+$/.test(value),
    `unsafe path ${String(value)}`
  );
  requireThat(
    value
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
          !part.endsWith('.')
      ),
    `unsafe path ${value}`
  );
  return value;
}

async function boundedRead(directory, relative, cap) {
  safeRelative(relative);
  requireThat(!(await lstat(directory)).isSymbolicLink(), 'corpus root symlink forbidden');
  const base = await realpath(directory);
  let current = directory;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => fail(`missing required file ${relative}`));
    requireThat(!stat.isSymbolicLink(), `symlink forbidden: ${relative}`);
  }
  requireThat((await lstat(current)).isFile(), `non-file: ${relative}`);
  const resolved = await realpath(current);
  const within = path.relative(base, resolved);
  requireThat(
    within && !within.startsWith('..') && !path.isAbsolute(within),
    `file escapes corpus: ${relative}`
  );
  const handle = await open(current, 'r');
  try {
    const stat = await handle.stat();
    requireThat(
      stat.isFile() && stat.size > 0 && stat.size <= cap,
      `size cap or non-file: ${relative}`
    );
    // Never allocate according to an untrusted file length or read an unbounded stream.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    requireThat(offset === stat.size, `file changed during read: ${relative}`);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function validateIdentity(fixture, ids, paths) {
  requireThat(fixture && typeof fixture === 'object', 'invalid fixture record');
  const { id } = fixture;
  requireThat(
    typeof id === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(id) && !ids.has(id),
    `invalid or duplicate ID ${id}`
  );
  ids.add(id);
  const location = safeRelative(fixture.path).toLowerCase();
  requireThat(!paths.has(location), `duplicate path ${location}`);
  paths.add(location);
}

function validDimension(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 100000;
}

function validateDimensions({ id, dimensions, evidence, family }) {
  if (dimensions === null) {
    requireThat(
      evidence === 'synthetic-negative' || ['xmp', 'colour'].includes(family),
      `${id}: invalid dimensions`
    );
    return;
  }
  requireThat(
    validDimension(dimensions?.width) &&
      validDimension(dimensions?.height) &&
      ['image', 'embedded-preview'].includes(dimensions.scope),
    `${id}: invalid dimensions`
  );
}

function validateFixtureMetadata(fixture) {
  const { id, family, format, evidence, bytes, sha256 } = fixture;
  requireThat(FAMILIES.includes(family) && nonempty(format), `${id}: invalid format/family`);
  requireThat(
    ['native', 'synthetic-valid', 'synthetic-negative'].includes(evidence) &&
      nonempty(fixture.purpose),
    `${id}: missing evidence/purpose`
  );
  validateDimensions(fixture);
  requireThat(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= LIMITS.file, `${id}: size cap`);
  requireThat(
    typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256),
    `${id}: invalid SHA-256`
  );
}

function validateLicense({ id, license }) {
  requireThat(
    ['CC0-1.0', 'CC-BY-4.0', 'MIT', 'Apache-2.0', 'BSD-3-Clause'].includes(license?.spdx) &&
      nonempty(license?.attribution) &&
      nonempty(license?.review),
    `${id}: missing or unreviewed license`
  );
  requireThat(
    Array.isArray(license.allowedUses) &&
      ['redistribute', 'modify', 'test'].every((use) => license.allowedUses.includes(use)) &&
      license.allowedUses.length === 3,
    `${id}: license allowed uses`
  );
  safeRelative(license.textPath);
  requireThat(/^[a-f0-9]{64}$/.test(license.textSha256), `${id}: missing license pin`);
}

function validateUpstreamSource({ id, source, sha256 }) {
  let url;
  try {
    url = new URL(source.url);
  } catch {
    fail(`${id}: invalid source URL`);
  }
  requireThat(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (source.url.includes(source.revision) || source.revision === sha256),
    `${id}: source must pin immutable revision or file content SHA-256`
  );
}

function validateSource(fixture) {
  const { id, source } = fixture;
  requireThat(
    source &&
      ['upstream', 'authored'].includes(source.kind) &&
      nonempty(source.url) &&
      /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(source.revision),
    `${id}: missing immutable source pin`
  );
  if (source.kind === 'authored') safeRelative(source.url);
  else validateUpstreamSource(fixture);
  safeRelative(source.evidencePath);
  requireThat(
    /^[a-f0-9]{64}$/.test(source.evidenceSha256),
    `${id}: missing provenance evidence pin`
  );
}

function validateTaskSelection(task, selection, ids) {
  requireThat(
    /^[0-9]{2,3}$/.test(task) &&
      Array.isArray(selection) &&
      selection.length > 0 &&
      selection.length <= LIMITS.fixtures &&
      new Set(selection).size === selection.length &&
      selection.every((id) => ids.has(id)),
    `invalid task selector ${task}`
  );
}

function validateTasks(tasks, ids) {
  requireThat(
    tasks && typeof tasks === 'object' && !Array.isArray(tasks) && Object.keys(tasks).length <= 100,
    'invalid task selectors'
  );
  for (const [task, selection] of Object.entries(tasks)) {
    validateTaskSelection(task, selection, ids);
  }
}

export function validateManifest(manifest) {
  requireThat(manifest?.version === 1, 'unsupported manifest version');
  requireThat(
    Array.isArray(manifest.fixtures) &&
      manifest.fixtures.length > 0 &&
      manifest.fixtures.length <= LIMITS.fixtures,
    'fixture count cap'
  );
  const ids = new Set();
  const paths = new Set();
  let total = 0;
  for (const fixture of manifest.fixtures) {
    validateIdentity(fixture, ids, paths);
    validateFixtureMetadata(fixture);
    validateLicense(fixture);
    validateSource(fixture);
    total += fixture.bytes;
    requireThat(total <= LIMITS.total, 'total size cap');
  }
  requireThat(
    FAMILIES.every((family) => manifest.fixtures.some((fixture) => fixture.family === family)),
    'required fixture family absent'
  );
  validateTasks(manifest.tasks, ids);
  return manifest;
}

export async function validateCorpus(directory = root) {
  const manifest = validateManifest(
    JSON.parse((await boundedRead(directory, 'manifest.json', LIMITS.manifest)).toString('utf8'))
  );
  const cached = new Map();
  const pinned = async (relative, expected, cap) => {
    if (!cached.has(relative)) cached.set(relative, await boundedRead(directory, relative, cap));
    const bytes = cached.get(relative);
    requireThat(bytes.length <= cap, `size cap: ${relative}`);
    requireThat(hash(bytes) === expected, `SHA-256 mismatch: ${relative}`);
    return bytes;
  };
  for (const fixture of manifest.fixtures) {
    const bytes = await pinned(fixture.path, fixture.sha256, Math.min(LIMITS.file, fixture.bytes));
    requireThat(bytes.length === fixture.bytes, `${fixture.id}: byte size mismatch`);
    await pinned(fixture.license.textPath, fixture.license.textSha256, LIMITS.manifest);
    await pinned(fixture.source.evidencePath, fixture.source.evidenceSha256, LIMITS.manifest);
    if (fixture.source.kind === 'authored')
      await pinned(fixture.source.url, fixture.source.revision, LIMITS.manifest);
  }
  return manifest;
}

export function selectFixtures(manifest, task) {
  validateManifest(manifest);
  requireThat(Object.hasOwn(manifest.tasks, task), `unknown task ${task}`);
  const selection = manifest.tasks[task];
  return selection
    .slice()
    .sort()
    .map((id) => manifest.fixtures.find((fixture) => fixture.id === id));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireThat(
      (process.argv.length === 3 && process.argv[2] === '--check') ||
        (process.argv.length === 4 && process.argv[2] === '--task'),
      'usage: --check | --task <number>'
    );
    const manifest = await validateCorpus();
    const fixtures =
      process.argv[2] === '--task'
        ? selectFixtures(manifest, process.argv[3])
        : manifest.fixtures.slice().sort((a, b) => a.id.localeCompare(b.id, 'en'));
    for (const fixture of fixtures)
      console.log(
        `${fixture.id} ${fixture.evidence} ${fixture.sha256} ${fixture.source.url}@${fixture.source.revision} ${fixture.license.spdx}`
      );
    console.log(`Validated ${manifest.fixtures.length} committed fixtures offline.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  FAMILIES,
  LIMITS,
  safeRelative,
  selectFixtures,
  validateCorpus,
  validateManifest,
} from './validate-test-corpus.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const body = 'bounded fixture';
const exec = promisify(execFile);
const manifest = () => ({
  version: 1,
  fixtures: FAMILIES.map((family) => ({
    id: `${family}-negative-v1`,
    path: `fixtures/${family}.bin`,
    family,
    format: family,
    evidence: 'synthetic-negative',
    dimensions: null,
    purpose: 'Truncated parser rejection case.',
    bytes: Buffer.byteLength(body),
    sha256: digest(body),
    license: {
      spdx: 'CC0-1.0',
      attribution: 'LightFrame contributors',
      review: 'Authored bytes dedicated to CC0.',
      allowedUses: ['redistribute', 'modify', 'test'],
      textPath: 'license.txt',
      textSha256: digest(body),
    },
    source: {
      kind: 'authored',
      url: 'generator.txt',
      revision: digest(body),
      evidencePath: 'provenance.txt',
      evidenceSha256: digest(body),
    },
  })),
  tasks: { 84: ['xmp-negative-v1', 'raf-negative-v1'] },
});

async function sandbox(t, change = () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lightframe-corpus-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'fixtures'));
  const data = manifest();
  for (const fixture of data.fixtures) await writeFile(path.join(directory, fixture.path), body);
  for (const name of ['license.txt', 'generator.txt', 'provenance.txt'])
    await writeFile(path.join(directory, name), body);
  change(data);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(data));
  return directory;
}

test('committed corpus validates offline and task selectors are stable', async () => {
  const data = await validateCorpus();
  const first = selectFixtures(data, '84').map((fixture) => fixture.id);
  assert.deepEqual(first, [...first].sort());
  assert.deepEqual(
    selectFixtures({ ...data, fixtures: [...data.fixtures].reverse() }, '84').map(
      (fixture) => fixture.id
    ),
    first
  );
  assert.throws(() => selectFixtures(data, '../84'), /unknown task/);
});

test('schema rejects duplicate IDs/paths, unreviewed licensing and missing families', () => {
  for (const [mutate, pattern] of [
    [
      (m) => {
        m.fixtures[1].id = m.fixtures[0].id;
      },
      /duplicate ID/,
    ],
    [
      (m) => {
        m.fixtures[1].path = m.fixtures[0].path.toUpperCase();
      },
      /duplicate path/,
    ],
    [
      (m) => {
        delete m.fixtures[0].license.review;
      },
      /unreviewed license/,
    ],
    [
      (m) => {
        m.fixtures[0].license.allowedUses = ['test'];
      },
      /allowed uses/,
    ],
    [
      (m) => {
        m.fixtures[0].license.spdx = 'unknown';
      },
      /license/,
    ],
    [
      (m) => {
        m.fixtures[0].source.revision = 'main';
      },
      /immutable source/,
    ],
    [
      (m) => {
        m.fixtures.pop();
      },
      /family absent/,
    ],
    [
      (m) => {
        m.fixtures[0].bytes = LIMITS.file + 1;
      },
      /size cap/,
    ],
    [
      (m) => {
        m.fixtures.forEach((f) => {
          f.bytes = LIMITS.file;
        });
      },
      /total size cap/,
    ],
    [
      (m) => {
        m.tasks['84'].push('absent');
      },
      /invalid task selector/,
    ],
    [
      (m) => {
        m.fixtures[0].evidence = 'native';
      },
      /dimensions/,
    ],
  ]) {
    const data = manifest();
    mutate(data);
    assert.throws(() => validateManifest(data), pattern);
  }
});

test('portable paths reject traversal, Windows aliases, UNC, ADS and rooted paths', () => {
  for (const value of [
    '../a',
    '/etc/passwd',
    'C:/a',
    'C:a',
    '\\\\host\\a',
    'fixtures\\a',
    'a//b',
    'a/./b',
    'a/../b',
    'a:b',
    'a%2fb',
    'nul.txt',
    'a/con',
    'a/lpt1.bin',
    'a./b',
  ])
    assert.throws(() => safeRelative(value), /unsafe path/);
  assert.equal(safeRelative('fixtures/raf-v1.raf'), 'fixtures/raf-v1.raf');
});

test('required missing and corrupted assets fail instead of skipping', async (t) => {
  const directory = await sandbox(t);
  await rm(path.join(directory, 'fixtures/raf.bin'));
  await assert.rejects(validateCorpus(directory), /missing required file fixtures\/raf.bin/);
  await writeFile(path.join(directory, 'fixtures/raf.bin'), 'corrupt fixture');
  await assert.rejects(validateCorpus(directory), /SHA-256 mismatch|size cap/);
});

test('actual byte sizes, manifest cap and pinned license/provenance are enforced', async (t) => {
  const directory = await sandbox(t, (data) => {
    data.fixtures[0].bytes += 1;
  });
  await assert.rejects(validateCorpus(directory), /byte size mismatch/);
  await writeFile(path.join(directory, 'manifest.json'), ' '.repeat(LIMITS.manifest + 1));
  await assert.rejects(validateCorpus(directory), /size cap/);
  const clean = await sandbox(t);
  await writeFile(path.join(clean, 'license.txt'), 'altered license');
  await assert.rejects(validateCorpus(clean), /SHA-256 mismatch/);
});

test('cached fixture bytes retain tighter license, provenance and generator caps', async (t) => {
  const large = Buffer.alloc(LIMITS.manifest + 1, 65);
  for (const role of ['license', 'provenance', 'generator']) {
    await t.test(role, async (child) => {
      const directory = await sandbox(child, (data) => {
        const fixture = data.fixtures[0];
        fixture.bytes = large.length;
        fixture.sha256 = digest(large);
        if (role === 'license') {
          fixture.license.textPath = fixture.path;
          fixture.license.textSha256 = fixture.sha256;
        } else if (role === 'provenance') {
          fixture.source.evidencePath = fixture.path;
          fixture.source.evidenceSha256 = fixture.sha256;
        } else {
          fixture.source.url = fixture.path;
          fixture.source.revision = fixture.sha256;
        }
      });
      await writeFile(path.join(directory, 'fixtures/raf.bin'), large);
      await assert.rejects(validateCorpus(directory), /size cap: fixtures\/raf.bin/);
    });
  }
});

test('nonregular final paths are rejected before opening', async (t) => {
  const directory = await sandbox(t);
  const fixture = path.join(directory, 'fixtures/raf.bin');
  await rm(fixture);
  await mkdir(fixture);
  await assert.rejects(validateCorpus(directory), /non-file: fixtures\/raf.bin/);
});

test('symlink files and directory junctions cannot redirect fixture reads', async (t) => {
  const directory = await sandbox(t);
  const fixture = path.join(directory, 'fixtures/raf.bin');
  await rm(fixture);
  // A directory junction works on Windows without Developer Mode privileges.
  await rm(path.join(directory, 'fixtures'), { recursive: true });
  await symlink(
    directory,
    path.join(directory, 'fixtures'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(validateCorpus(directory), /symlink forbidden/);
});

test('pinned text-like bytes survive a Git checkout with core.autocrlf=true', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lightframe-corpus-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corpus = path.join(directory, 'test-corpus');
  await mkdir(corpus);
  const actual = path.resolve(import.meta.dirname, '..', 'test-corpus');
  await copyFile(path.join(actual, '.gitattributes'), path.join(corpus, '.gitattributes'));
  const files = [
    'fixtures/rating-v1.xmp',
    'generators/geometry.py',
    'licenses/CC0-1.0.txt',
    'provenance/raw-pixls-2726.json',
  ];
  const original = new Map();
  for (const file of files) {
    const bytes = await readFile(path.join(actual, file));
    original.set(file, bytes);
    await mkdir(path.dirname(path.join(corpus, file)), { recursive: true });
    await writeFile(path.join(corpus, file), bytes);
  }
  const git = (...args) => exec('git', args, { cwd: directory });
  await git('init', '-q');
  await git('config', 'core.autocrlf', 'true');
  await git('add', 'test-corpus');
  for (const file of files) await rm(path.join(corpus, file));
  await git('checkout-index', '--all', '--force');
  for (const file of files)
    assert.deepEqual(await readFile(path.join(corpus, file)), original.get(file), file);
});

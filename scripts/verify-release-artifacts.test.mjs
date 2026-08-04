import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertArchiveAuthenticode,
  assertAuthenticode,
  assertChecksums,
  assertSbom,
  assertUpdaterSignatures,
} from './verify-release-artifacts.mjs';

test('release verifier rejects changed artifacts and accepts a parseable versioned SBOM', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-release-'));
  try {
    const artifact = path.join(folder, 'LightFrame_8.7.6_x64-setup.exe');
    await fs.writeFile(artifact, 'artifact');
    const hash = createHash('sha256').update('artifact').digest('hex');
    const sums = path.join(folder, 'SHA256SUMS.txt');
    await fs.writeFile(sums, `${hash} *${path.basename(artifact)}\n`);
    await assertChecksums({ artifactDirectory: folder, checksumFile: sums });
    await fs.writeFile(artifact, 'changed');
    await assert.rejects(assertChecksums({ artifactDirectory: folder, checksumFile: sums }));
    const sbom = path.join(folder, 'lightframe-8.7.6.spdx.json');
    await fs.writeFile(
      sbom,
      JSON.stringify({
        spdxVersion: 'SPDX-2.3',
        packages: [{ name: 'lightframe', versionInfo: '8.7.6' }, { name: 'react' }],
      })
    );
    await assertSbom({ sbomPath: sbom, expectedVersion: '8.7.6' });
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('updater verifier invokes the streaming verifier for each final artifact and rejects missing signatures', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-updater-signatures-'));
  try {
    const artifact = path.join(folder, 'LightFrame_8.7.6_x64-setup.exe');
    await fs.writeFile(artifact, 'artifact');
    await fs.writeFile(`${artifact}.sig`, 'signature');
    const calls = [];
    await assertUpdaterSignatures({
      artifactDirectory: folder,
      execute: async (command, commandArgs) => calls.push([command, commandArgs]),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'cargo');
    assert.ok(calls[0][1].includes('--artifact'));
    await fs.rm(`${artifact}.sig`);
    await assert.rejects(
      assertUpdaterSignatures({ artifactDirectory: folder, execute: async () => {} })
    );
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('required Authenticode validates executables embedded in updater archives', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-updater-archive-'));
  try {
    await fs.writeFile(path.join(folder, 'LightFrame.nsis.zip'), 'archive');
    await assert.doesNotReject(
      assertArchiveAuthenticode({
        artifactDirectory: folder,
        required: true,
        getStatus: async () => 'Valid',
        getArchiveExecutables: async () => [path.join(folder, 'unpacked', 'lightframe.exe')],
      })
    );
    await assert.rejects(
      assertArchiveAuthenticode({
        artifactDirectory: folder,
        required: true,
        getStatus: async () => 'NotSigned',
        getArchiveExecutables: async () => [path.join(folder, 'unpacked', 'lightframe.exe')],
      })
    );
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('Authenticode accurately permits unsigned artifacts only when not required', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-authenticode-'));
  try {
    await fs.writeFile(path.join(folder, 'LightFrame_8.7.6_x64-setup.exe'), 'artifact');
    await assertAuthenticode({
      artifactDirectory: folder,
      required: false,
      getStatus: async () => 'NotSigned',
    });
    await assert.rejects(
      assertAuthenticode({
        artifactDirectory: folder,
        required: true,
        getStatus: async () => 'NotSigned',
      })
    );
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

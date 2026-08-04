import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { finalizeUpdaterRelease, finalUpdaterManifest } from './finalize-updater-release.mjs';

const msi = 'LightFrame_8.7.6_x64_en-US.msi';
const nsis = 'LightFrame_8.7.6_x64-setup.nsis.zip';

test('final manifest maps generic, MSI, and NSIS entries to their exact final assets', () => {
  const manifest = finalUpdaterManifest({
    version: '8.7.6',
    tag: 'app-v8.7.6',
    files: [msi, nsis, `${msi}.sig`, `${nsis}.sig`],
    signatures: { [msi]: 'msi signature', [nsis]: 'nsis signature' },
  });
  assert.match(
    manifest.platforms['windows-x86_64'].url,
    /app-v8\.7\.6\/LightFrame_8\.7\.6_x64-setup\.nsis\.zip$/
  );
  assert.match(manifest.platforms['windows-x86_64-msi'].url, /LightFrame_8\.7\.6_x64_en-US\.msi$/);
  assert.match(
    manifest.platforms['windows-x86_64-nsis'].url,
    /LightFrame_8\.7\.6_x64-setup\.nsis\.zip$/
  );
  assert.equal(manifest.platforms['windows-x86_64-nsis'].signature, 'nsis signature');
});

test('finalizer rejects duplicate, missing, and unsafe updater assets', () => {
  assert.throws(() =>
    finalUpdaterManifest({
      version: '8.7.6',
      tag: 'app-v8.7.6',
      files: ['one.msi', 'two.msi'],
      signatures: {},
    })
  );
  assert.throws(() =>
    finalUpdaterManifest({ version: '8.7.6', tag: 'app-v8.7.6', files: [msi], signatures: {} })
  );
  assert.throws(() =>
    finalUpdaterManifest({
      version: '8.7.6',
      tag: 'app-v8.7.6',
      files: ['../escape.exe'],
      signatures: {},
    })
  );
});

test('finalizer replaces stale signatures and invokes an injectable signer with literal paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-finalize-'));
  try {
    await fs.writeFile(path.join(directory, msi), 'msi');
    await fs.writeFile(path.join(directory, `${msi}.sig`), 'stale');
    const signed = [];
    const manifest = await finalizeUpdaterRelease({
      artifactDirectory: directory,
      version: '8.7.6',
      tag: 'app-v8.7.6',
      signArtifact: async (artifact) => {
        signed.push(artifact);
        await fs.writeFile(`${artifact}.sig`, 'final signature');
      },
    });
    assert.deepEqual(signed, [path.join(directory, msi)]);
    assert.equal(manifest.platforms['windows-x86_64'].signature, 'final signature');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

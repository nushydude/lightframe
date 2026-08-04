import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertDownloadedMatchesLocal,
  assertManifestSignatures,
  assertManifestUrls,
  assertReleaseInventory,
} from './verify-uploaded-release-assets.mjs';

test('uploaded release verifier requires the exact draft release, inventory, and stable asset URLs', async () => {
  const tag = 'app-v8.7.6';
  const sha = 'a'.repeat(40);
  const release = {
    id: 42,
    tag_name: tag,
    draft: true,
    target_commitish: sha,
    assets: [{ name: 'LightFrame.exe' }, { name: 'LightFrame.exe.sig' }, { name: 'latest.json' }],
  };
  const assets = assertReleaseInventory({
    release,
    releaseId: '42',
    tag,
    sha,
    localNames: ['latest.json', 'LightFrame.exe.sig', 'LightFrame.exe'],
  });
  assertManifestUrls({
    tag,
    assets,
    manifest: {
      platforms: {
        'windows-x86_64': {
          url: `https://github.com/nushydude/lightframe/releases/download/${tag}/LightFrame.exe`,
          signature: 'signature',
        },
      },
    },
  });
  assert.throws(() =>
    assertManifestUrls({
      manifest: { platforms: { x: { url: 'https://example.invalid/a', signature: 'x' } } },
      tag,
      assets,
    })
  );
  assert.throws(() =>
    assertReleaseInventory({
      release: { ...release, id: 43 },
      releaseId: '42',
      tag,
      sha,
      localNames: [],
    })
  );
});

test('uploaded release verifier rejects a manifest signature that differs from uploaded bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-uploaded-signature-'));
  try {
    await fs.writeFile(path.join(directory, 'LightFrame.exe.sig'), 'uploaded signature\n');
    const tag = 'app-v8.7.6';
    const assets = new Map([
      ['LightFrame.exe', {}],
      ['LightFrame.exe.sig', {}],
    ]);
    const manifest = {
      platforms: {
        'windows-x86_64': {
          url: `https://github.com/nushydude/lightframe/releases/download/${tag}/LightFrame.exe`,
          signature: 'different signature\n',
        },
      },
    };
    await assert.rejects(
      assertManifestSignatures({ manifest, tag, assets, signatureDirectory: directory })
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('uploaded release verifier rejects byte changes after download', async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-local-release-'));
  const downloaded = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-downloaded-release-'));
  try {
    await fs.writeFile(path.join(local, 'LightFrame.exe'), 'final');
    await fs.writeFile(path.join(downloaded, 'LightFrame.exe'), 'tampered');
    await assert.rejects(
      assertDownloadedMatchesLocal({
        localDirectory: local,
        downloadedDirectory: downloaded,
        names: ['LightFrame.exe'],
      })
    );
  } finally {
    await fs.rm(local, { recursive: true, force: true });
    await fs.rm(downloaded, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv.at(index + 1);
};
const safeName = (name) => {
  assert.match(name, /^[^\\/]+$/, `Unsafe release asset name: ${name}`);
  return name;
};

export async function sha256(file) {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

export function assertReleaseInventory({ release, releaseId, tag, sha, localNames }) {
  assert.equal(
    String(release.id),
    String(releaseId),
    'Release API returned a different release ID'
  );
  assert.equal(release.tag_name, tag, 'Release tag does not match the final manifest tag');
  assert.equal(
    release.draft,
    true,
    'Final assets must be verified while the release is still draft'
  );
  assert.equal(release.target_commitish, sha, 'Release does not target the gated commit SHA');
  const remoteNames = release.assets.map((asset) => safeName(asset.name)).sort();
  assert.deepEqual(
    remoteNames,
    [...localNames].map(safeName).sort(),
    'Draft asset inventory differs from final local artifacts'
  );
  return new Map(release.assets.map((asset) => [asset.name, asset]));
}

export function assertManifestUrls({ manifest, tag, assets }) {
  const artifactNames = [];
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    assert.ok(entry?.url && entry.signature, `Updater entry ${platform} is incomplete`);
    const expectedPrefix = `https://github.com/nushydude/lightframe/releases/download/${tag}/`;
    assert.ok(
      entry.url.startsWith(expectedPrefix),
      `Updater ${platform} points at a different tag`
    );
    const name = decodeURIComponent(entry.url.slice(expectedPrefix.length));
    assert.ok(assets.has(name), `Updater ${platform} references missing uploaded asset ${name}`);
    assert.ok(
      assets.has(`${name}.sig`),
      `Updater ${platform} signature asset is missing for ${name}`
    );
    artifactNames.push(name);
  }
  return artifactNames;
}

export async function assertManifestSignatures({ manifest, tag, assets, signatureDirectory }) {
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    const [artifact] = assertManifestUrls({
      manifest: { platforms: { [platform]: entry } },
      tag,
      assets,
    });
    const signature = await fs.readFile(path.join(signatureDirectory, `${artifact}.sig`), 'utf8');
    assert.equal(
      entry.signature,
      signature,
      `Updater ${platform} signature differs from uploaded asset`
    );
  }
}

export async function assertDownloadedMatchesLocal({ localDirectory, downloadedDirectory, names }) {
  for (const name of names) {
    const [local, downloaded] = await Promise.all([
      sha256(path.join(localDirectory, safeName(name))),
      sha256(path.join(downloadedDirectory, safeName(name))),
    ]);
    assert.equal(downloaded, local, `Uploaded asset bytes differ for ${name}`);
  }
}

export async function verifyUploadedReleaseAssets({
  repository,
  token,
  releaseId,
  tag,
  sha,
  localDirectory,
  downloadDirectory,
  fetchImpl = fetch,
  execute = run,
}) {
  assert.match(String(releaseId), /^\d+$/, 'releaseId must be numeric');
  assert.ok(repository && token, 'GH_REPO and GH_TOKEN are required');
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/${releaseId}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  assert.ok(response.ok, `Unable to fetch exact draft release ${releaseId}: ${response.status}`);
  const release = await response.json();
  const localNames = (await fs.readdir(localDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const assets = assertReleaseInventory({ release, releaseId, tag, sha, localNames });
  await fs.mkdir(downloadDirectory, { recursive: true });
  for (const name of localNames) {
    await execute(
      'gh',
      [
        'release',
        'download',
        tag,
        '--repo',
        repository,
        '--pattern',
        safeName(name),
        '--dir',
        downloadDirectory,
      ],
      {
        env: { ...process.env, GH_TOKEN: token },
        windowsHide: true,
      }
    );
  }
  await assertDownloadedMatchesLocal({
    localDirectory,
    downloadedDirectory: downloadDirectory,
    names: localNames,
  });
  const manifest = JSON.parse(
    await fs.readFile(path.join(downloadDirectory, 'latest.json'), 'utf8')
  );
  assertManifestUrls({ manifest, tag, assets });
  await assertManifestSignatures({
    manifest,
    tag,
    assets,
    signatureDirectory: downloadDirectory,
  });
}

async function main() {
  const [releaseId, tag, sha, localDirectory, downloadDirectory] = [
    argument('--release-id'),
    argument('--tag'),
    argument('--sha'),
    argument('--local-dir'),
    argument('--download-dir'),
  ];
  assert.ok(
    releaseId && tag && sha && localDirectory && downloadDirectory,
    'Missing uploaded-release verification argument'
  );
  await verifyUploadedReleaseAssets({
    repository: process.env.GH_REPO,
    token: process.env.GH_TOKEN,
    releaseId,
    tag,
    sha,
    localDirectory,
    downloadDirectory,
  });
}

if (process.argv[1]?.endsWith('verify-uploaded-release-assets.mjs')) await main();

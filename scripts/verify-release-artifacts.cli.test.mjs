import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const verifier = path.join(root, 'scripts', 'verify-release-artifacts.mjs');
const policy = path.join(root, 'scripts', 'authenticode-policy.mjs');
const publicKey = 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';
const signature = `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==`;

async function invoke(script, args) {
  return execute(process.execPath, [script, ...args], { cwd: root });
}

async function finalEvidenceFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-final-evidence-'));
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-updater-config-'));
  const artifact = path.join(directory, 'LightFrame_8.7.6_x64-setup.exe');
  const config = path.join(configDirectory, 'tauri.conf.json');
  const latest = path.join(directory, 'latest.json');
  const sbom = path.join(directory, 'lightframe-8.7.6.spdx.json');
  await fs.writeFile(artifact, 'test');
  await fs.writeFile(`${artifact}.sig`, signature);
  await fs.writeFile(
    config,
    JSON.stringify({
      plugins: {
        updater: {
          pubkey: Buffer.from(`untrusted comment: fixture\n${publicKey}`).toString('base64'),
        },
      },
    })
  );
  await fs.writeFile(
    latest,
    JSON.stringify({
      version: '8.7.6',
      platforms: { 'windows-x86_64': { signature } },
    })
  );
  await fs.writeFile(
    sbom,
    JSON.stringify({
      spdxVersion: 'SPDX-2.3',
      packages: [{ name: 'lightframe', versionInfo: '8.7.6' }, { name: 'fixture' }],
    })
  );
  const names = await fs.readdir(directory);
  const checksums = await Promise.all(
    names.map(async (name) => {
      const hash = createHash('sha256')
        .update(await fs.readFile(path.join(directory, name)))
        .digest('hex');
      return `${hash} *${name}`;
    })
  );
  const checksumFile = path.join(directory, 'SHA256SUMS.txt');
  await fs.writeFile(checksumFile, `${checksums.join('\n')}\n`);
  return { directory, configDirectory, artifact, config, sbom, checksumFile };
}

test('verifier CLI accepts the workflow reported-version and artifact-paths invocation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-reported-artifact-'));
  try {
    const artifact = path.join(directory, 'LightFrame_8.7.6_x64-setup.exe');
    await fs.writeFile(artifact, 'fixture');
    await assert.doesNotReject(
      invoke(verifier, [
        '--expected-version',
        '8.7.6',
        '--reported-version',
        '8.7.6',
        '--artifact-paths',
        JSON.stringify([artifact]),
      ])
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('verifier CLI accepts final evidence without a reported artifact pair and rejects partial pairs', async () => {
  const fixture = await finalEvidenceFixture();
  try {
    await assert.doesNotReject(
      invoke(verifier, [
        '--expected-version',
        '8.7.6',
        '--artifact-dir',
        fixture.directory,
        '--checksums',
        fixture.checksumFile,
        '--sbom',
        fixture.sbom,
        '--require-authenticode',
        'false',
        '--tauri-config',
        fixture.config,
      ])
    );
    await assert.rejects(
      invoke(verifier, ['--expected-version', '8.7.6', '--reported-version', '8.7.6']),
      /supplied together/
    );
    await assert.rejects(
      invoke(verifier, ['--expected-version', '8.7.6', '--artifact-paths', '[]']),
      /supplied together/
    );
  } finally {
    await fs.rm(fixture.directory, { recursive: true, force: true });
    await fs.rm(fixture.configDirectory, { recursive: true, force: true });
  }
});

test('Authenticode policy CLI resolves unset, false, true, invalid, and Azure provider modes', async () => {
  const resolve = async (args) => (await invoke(policy, args)).stdout.trim();
  assert.equal(await resolve([]), 'false');
  assert.equal(await resolve(['--required', 'false']), 'false');
  assert.equal(await resolve(['--required', 'true']), 'true');
  await assert.rejects(resolve(['--required', 'invalid']), /must be true or false/);
  assert.equal(
    await resolve(['--provider', 'azure-trusted-signing', '--required', 'invalid']),
    'true'
  );
});

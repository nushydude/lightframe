import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertSemver } from './version-contract.mjs';

const run = promisify(execFile);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

export function parseArtifactPaths(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Tauri Action has also emitted newline-separated paths in previous versions.
  }
  return value.split(/\r?\n|;/).filter(Boolean);
}

export async function assertReportedArtifactVersion({
  expectedVersion,
  reportedVersion,
  artifactPaths,
}) {
  assertSemver(expectedVersion);
  assert.equal(
    reportedVersion,
    expectedVersion,
    'Tauri Action reported an unexpected application version'
  );
  assert.ok(artifactPaths.length > 0, 'Tauri Action did not report any release artifacts');
  for (const artifact of artifactPaths) {
    await fs.access(artifact);
  }
  const installers = artifactPaths.filter((artifact) => /\.(?:msi|exe|nsis\.zip)$/i.test(artifact));
  assert.ok(installers.length > 0, 'Tauri Action did not report a Windows installer artifact');
  for (const installer of installers) {
    assert.ok(
      installer.includes(expectedVersion),
      `Installer filename does not include ${expectedVersion}: ${installer}`
    );
  }
}

export async function assertUpdaterMetadataVersion({ expectedVersion, artifactDirectory }) {
  const entries = await fs.readdir(artifactDirectory, { recursive: true, withFileTypes: true });
  const manifests = entries
    .filter((entry) => entry.isFile() && entry.name === 'latest.json')
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  assert.ok(
    manifests.length > 0,
    `No latest.json updater metadata found below ${artifactDirectory}`
  );
  for (const manifest of manifests) {
    const metadata = JSON.parse(await fs.readFile(manifest, 'utf8'));
    assert.equal(
      metadata.version,
      expectedVersion,
      `${manifest} has an unexpected updater version`
    );
    assert.ok(
      metadata.platforms && Object.keys(metadata.platforms).length > 0,
      `${manifest} has no updater platforms`
    );
    for (const [platform, release] of Object.entries(metadata.platforms)) {
      assert.ok(release.signature, `${manifest} platform ${platform} has no updater signature`);
    }
  }
}

export async function assertChecksums({ artifactDirectory, checksumFile }) {
  const entries = (await fs.readFile(checksumFile, 'utf8')).split(/\r?\n/).filter(Boolean);
  assert.ok(entries.length > 0, 'Checksum file is empty');
  const seen = new Set();
  for (const entry of entries) {
    const match = entry.match(/^([a-fA-F0-9]{64}) \*(.+)$/);
    assert.ok(match, `Malformed SHA-256 checksum entry: ${entry}`);
    const relative = match[2];
    assert.ok(
      !path.isAbsolute(relative) && !relative.includes('..') && !/[\\/]/.test(relative),
      `Unsafe checksum path: ${relative}`
    );
    assert.ok(!seen.has(relative), `Duplicate checksum entry: ${relative}`);
    seen.add(relative);
    const bytes = await fs.readFile(path.join(artifactDirectory, relative));
    const actual = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, match[1].toLowerCase(), `Checksum mismatch for ${match[2]}`);
  }
  const expected = (await fs.readdir(artifactDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== path.basename(checksumFile))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    [...seen].sort(),
    expected,
    'Checksums must cover every final artifact exactly once'
  );
}

export async function assertSbom({ sbomPath, expectedVersion }) {
  const sbom = JSON.parse(await fs.readFile(sbomPath, 'utf8'));
  assert.equal(sbom.spdxVersion, 'SPDX-2.3', 'Release SBOM must be SPDX 2.3');
  assert.ok(Array.isArray(sbom.packages) && sbom.packages.length > 1, 'SBOM has no dependencies');
  assert.ok(
    sbom.packages.some((pkg) => pkg.name === 'lightframe' && pkg.versionInfo === expectedVersion),
    'SBOM does not describe the expected LightFrame version'
  );
}

export async function authenticodeStatus(artifact) {
  if (process.platform !== 'win32' || !/\.(msi|exe)$/i.test(artifact)) return 'not-applicable';
  const script = `(Get-AuthenticodeSignature -LiteralPath '${artifact.replace(/'/g, "''")}').Status`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(output.trim() || 'UnknownError')
        : reject(new Error(`Authenticode check failed (${code})`))
    );
  });
}

export async function assertAuthenticode({
  artifactDirectory,
  required,
  getStatus = authenticodeStatus,
}) {
  const entries = await fs.readdir(artifactDirectory);
  const installers = entries.filter((entry) => /\.(msi|exe)$/i.test(entry));
  assert.ok(installers.length > 0, 'No Windows installer found for Authenticode verification');
  const statuses = await Promise.all(
    installers.map(async (entry) => [entry, await getStatus(path.join(artifactDirectory, entry))])
  );
  for (const [entry, status] of statuses) {
    console.log(`Authenticode ${entry}: ${status}`);
    if (required)
      assert.equal(status, 'Valid', `Authenticode is required but ${entry} is ${status}`);
  }
}

export async function assertUpdaterSignatures({ artifactDirectory, execute = run, manifestPath }) {
  const artifacts = (await fs.readdir(artifactDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /(?:\.nsis\.zip|\.msi|\.exe)$/i.test(entry.name))
    .map((entry) => entry.name);
  assert.ok(artifacts.length > 0, 'No updater artifacts found for signature verification');
  for (const artifact of artifacts) {
    const artifactPath = path.join(artifactDirectory, artifact);
    const signaturePath = `${artifactPath}.sig`;
    await fs.access(signaturePath);
    await execute(
      'cargo',
      [
        'run',
        '--locked',
        '--manifest-path',
        'tools/updater-signature-verifier/Cargo.toml',
        '--',
        '--artifact',
        artifactPath,
        '--signature',
        signaturePath,
        '--tauri-config',
        manifestPath ?? path.join('src-tauri', 'tauri.conf.json'),
      ],
      { env: process.env, windowsHide: true }
    );
  }
}

export async function archiveExecutables(archive, temporaryDirectory) {
  const escapedArchive = archive.replace(/'/g, "''");
  const escapedDirectory = temporaryDirectory.replace(/'/g, "''");
  await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDirectory}' -Force`,
  ]);
  const entries = await fs.readdir(temporaryDirectory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

export async function assertArchiveAuthenticode({
  artifactDirectory,
  required,
  getStatus = authenticodeStatus,
  getArchiveExecutables = archiveExecutables,
}) {
  if (!required) return;
  const archives = (await fs.readdir(artifactDirectory))
    .filter((entry) => /\.nsis\.zip$/i.test(entry))
    .map((entry) => path.join(artifactDirectory, entry));
  for (const archive of archives) {
    const temporaryDirectory = await fs.mkdtemp(path.join(artifactDirectory, '.verify-updater-'));
    try {
      const executables = await getArchiveExecutables(archive, temporaryDirectory);
      assert.ok(
        executables.length > 0,
        `Updater archive ${path.basename(archive)} contains no executable`
      );
      for (const executable of executables) {
        const status = await getStatus(executable);
        assert.equal(status, 'Valid', `Embedded updater executable ${executable} is ${status}`);
      }
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export async function assertExpectedInstallerNames({ artifactDirectory, expectedVersion }) {
  const installers = (await fs.readdir(artifactDirectory)).filter((entry) =>
    /\.(msi|exe)$/i.test(entry)
  );
  assert.ok(installers.length > 0, 'No Windows installer found');
  for (const installer of installers) {
    assert.ok(
      installer.includes(expectedVersion),
      `Installer filename does not include ${expectedVersion}: ${installer}`
    );
  }
}

const expectedVersion = argument('--expected-version');
if (expectedVersion) {
  const reportedVersion = argument('--reported-version');
  const artifactPathsValue = argument('--artifact-paths');
  assert.equal(
    reportedVersion === undefined,
    artifactPathsValue === undefined,
    '--reported-version and --artifact-paths must be supplied together'
  );
  if (reportedVersion !== undefined && artifactPathsValue !== undefined) {
    await assertReportedArtifactVersion({
      expectedVersion,
      reportedVersion,
      artifactPaths: parseArtifactPaths(artifactPathsValue),
    });
  }
  const artifactDirectory = argument('--artifact-dir');
  const manifestPath = argument('--tauri-config');
  if (artifactDirectory) {
    await assertUpdaterMetadataVersion({ expectedVersion, artifactDirectory });
  }
  const checksumFile = argument('--checksums');
  if (checksumFile) await assertChecksums({ artifactDirectory, checksumFile });
  const sbomPath = argument('--sbom');
  if (sbomPath) await assertSbom({ sbomPath, expectedVersion });
  const authenticodeRequired = argument('--require-authenticode');
  if (authenticodeRequired !== undefined) {
    assert.ok(
      ['true', 'false'].includes(authenticodeRequired),
      'require-authenticode must be exactly true or false'
    );
    await assertExpectedInstallerNames({ artifactDirectory, expectedVersion });
    await assertAuthenticode({ artifactDirectory, required: authenticodeRequired === 'true' });
    await assertArchiveAuthenticode({
      artifactDirectory,
      required: authenticodeRequired === 'true',
    });
  }
  if (artifactDirectory) await assertUpdaterSignatures({ artifactDirectory, manifestPath });
  console.log(`release artifacts report version ${expectedVersion}`);
}

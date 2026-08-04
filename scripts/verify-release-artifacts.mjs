import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSemver } from './version-contract.mjs';

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
  }
}

const expectedVersion = argument('--expected-version');
if (expectedVersion) {
  const reportedVersion = argument('--reported-version');
  const artifactPaths = parseArtifactPaths(argument('--artifact-paths'));
  await assertReportedArtifactVersion({ expectedVersion, reportedVersion, artifactPaths });
  const artifactDirectory = argument('--artifact-dir');
  if (artifactDirectory) {
    await assertUpdaterMetadataVersion({ expectedVersion, artifactDirectory });
  }
  console.log(`release artifacts report version ${expectedVersion}`);
}

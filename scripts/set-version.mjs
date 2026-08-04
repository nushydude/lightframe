import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertVersionContract,
  assertSemver,
  extractLockPackageVersion,
  versionedManifestContents,
} from './version-contract.mjs';

const defaultRoot = path.resolve(import.meta.dirname, '..');

async function refreshCargoLockfile({ root, lockfileIsCurrent }) {
  await new Promise((resolve, reject) => {
    const processHandle = spawn(
      process.platform === 'win32' ? 'cargo.exe' : 'cargo',
      [
        'check',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        ...(lockfileIsCurrent ? ['--locked'] : []),
      ],
      { cwd: root, stdio: 'inherit' }
    );
    processHandle.once('error', reject);
    processHandle.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`cargo check exited with ${code}`))
    );
  });
}

export async function setVersion({
  root = defaultRoot,
  version,
  refreshLockfile = refreshCargoLockfile,
}) {
  assertSemver(version);
  const files = {
    packageText: path.join(root, 'package.json'),
    cargoToml: path.join(root, 'src-tauri', 'Cargo.toml'),
    tauriText: path.join(root, 'src-tauri', 'tauri.conf.json'),
    cargoLock: path.join(root, 'src-tauri', 'Cargo.lock'),
  };
  const original = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(file, 'utf8')])
    )
  );
  const updated = versionedManifestContents({ ...original, version });

  try {
    // Cargo owns the lockfile. Compare its actual local package record, not a manifest value, so a
    // stale lockfile is repaired even if all declared manifests already name the requested version.
    const lockfileIsCurrent = extractLockPackageVersion(original.cargoLock) === version;
    await Promise.all([
      fs.writeFile(files.packageText, updated.packageText),
      fs.writeFile(files.cargoToml, updated.cargoToml),
      fs.writeFile(files.tauriText, updated.tauriText),
    ]);
    await refreshLockfile({ root, lockfileIsCurrent });
    await assertVersionContract({ root });
    return version;
  } catch (error) {
    await Promise.all(
      Object.entries(files).map(([key, file]) => fs.writeFile(file, original[key]))
    );
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv.at(2);
  if (!version) {
    throw new Error('Usage: pnpm run version:set -- <semver>');
  }
  await setVersion({ version });
  console.log(`version metadata and Cargo.lock synchronized at ${version}`);
}

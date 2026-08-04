import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv.at(index + 1);
};
const updaterPattern = /(?:\.nsis\.zip|\.msi|\.exe)$/i;
const tauriCliPath = path.join(
  path.dirname(fileURLToPath(import.meta.resolve('@tauri-apps/cli'))),
  'tauri.js'
);

function safeLeafName(name) {
  assert.match(name, /^[^\\/]+$/, `Unsafe release artifact name: ${name}`);
  assert.ok(name !== '.' && name !== '..', `Unsafe release artifact name: ${name}`);
  return name;
}

function selectOne(files, expression, description) {
  const matches = files.filter((file) => expression.test(file));
  assert.ok(
    matches.length <= 1,
    `Expected at most one ${description}; found ${matches.join(', ')}`
  );
  return matches[0];
}

export function selectFinalUpdaterArtifacts(files) {
  const candidates = files.filter((file) => updaterPattern.test(file)).map(safeLeafName);
  assert.ok(candidates.length > 0, 'No final Windows updater artifact was produced');
  const nsis = selectOne(candidates, /\.nsis\.zip$/i, 'NSIS updater archive');
  const msi = selectOne(candidates, /\.msi$/i, 'MSI updater artifact');
  const exe = selectOne(candidates, /\.exe$/i, 'EXE updater artifact');
  const generic = nsis ?? msi ?? exe;
  return { generic, nsis: nsis ?? exe, msi, candidates };
}

function releaseUrl(tag, name) {
  assert.match(tag, /^app-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid release tag');
  return `https://github.com/nushydude/lightframe/releases/download/${tag}/${encodeURIComponent(name)}`;
}

export function finalUpdaterManifest({ version, tag, files, signatures }) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid release version');
  const selected = selectFinalUpdaterArtifacts(files);
  const signatureFor = (file) => {
    const signature = signatures[file];
    assert.ok(signature?.trim(), `No final updater signature for ${file}`);
    return signature;
  };
  const platforms = {
    'windows-x86_64': {
      url: releaseUrl(tag, selected.generic),
      signature: signatureFor(selected.generic),
    },
  };
  if (selected.msi) {
    platforms['windows-x86_64-msi'] = {
      url: releaseUrl(tag, selected.msi),
      signature: signatureFor(selected.msi),
    };
  }
  if (selected.nsis) {
    platforms['windows-x86_64-nsis'] = {
      url: releaseUrl(tag, selected.nsis),
      signature: signatureFor(selected.nsis),
    };
  }
  return {
    version,
    notes: `LightFrame v${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

export async function signUpdaterArtifact(
  artifact,
  { runCommand = run, executable = process.execPath, cliPath = tauriCliPath } = {}
) {
  await runCommand(executable, [cliPath, 'signer', 'sign', artifact], {
    windowsHide: true,
  });
}

export async function finalizeUpdaterRelease({
  artifactDirectory,
  version,
  tag,
  readDirectory = fs.readdir,
  removeFile = fs.rm,
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  signArtifact = signUpdaterArtifact,
}) {
  assert.ok(artifactDirectory, 'artifactDirectory is required');
  const directory = path.resolve(artifactDirectory);
  const files = (await readDirectory(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => safeLeafName(entry.name));
  const selected = selectFinalUpdaterArtifacts(files);
  for (const artifact of selected.candidates) {
    const signaturePath = path.join(directory, `${artifact}.sig`);
    await removeFile(signaturePath, { force: true });
    await signArtifact(path.join(directory, artifact));
  }
  const finalFiles = (await readDirectory(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => safeLeafName(entry.name));
  const signatures = Object.fromEntries(
    await Promise.all(
      selected.candidates.map(async (artifact) => [
        artifact,
        await readFile(path.join(directory, `${artifact}.sig`), 'utf8'),
      ])
    )
  );
  const manifest = finalUpdaterManifest({ version, tag, files: finalFiles, signatures });
  await writeFile(path.join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const artifactDirectory = argument('--artifact-dir');
  const version = argument('--version');
  const tag = argument('--tag');
  assert.ok(
    artifactDirectory && version && tag,
    '--artifact-dir, --version, and --tag are required'
  );
  await finalizeUpdaterRelease({ artifactDirectory, version, tag });
}

if (process.argv[1]?.endsWith('finalize-updater-release.mjs')) await main();

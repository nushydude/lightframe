import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// SemVer 2.0.0 without a leading `v`: manifests store values in this form.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function assertSemver(version) {
  assert.match(version, SEMVER_PATTERN, `Invalid semantic version: ${version}`);
  return version;
}

export function parseReleaseTag(tag) {
  assert.match(tag, /^v/, `Release tag must start with "v": ${tag}`);
  const version = tag.slice(1);
  assertSemver(version);
  assert.ok(!version.includes('+'), `Release tags cannot include SemVer build metadata: ${tag}`);
  return version;
}

export function extractCargoManifestVersion(cargoToml) {
  const packageStart = cargoToml.search(/^\[package\]\s*$/m);
  assert.notEqual(packageStart, -1, 'Could not find [package] in Cargo.toml');
  const afterHeader = cargoToml.slice(packageStart).replace(/^\[package\]\s*\r?\n?/, '');
  const nextSection = afterHeader.search(/^\[/m);
  const packageSection = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  assert.ok(version, 'Could not find [package].version in Cargo.toml');
  return version;
}

export function extractLockPackageVersion(cargoLock, packageName = 'lightframe') {
  const packageBlocks = cargoLock.split(/^\[\[package\]\]\r?$/m).slice(1);
  const packageNameExpression = new RegExp(
    `^name\\s*=\\s*"${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*$`,
    'm'
  );
  const rootBlocks = packageBlocks.filter(
    (block) =>
      packageNameExpression.test(block) &&
      !/^source\s*=/m.test(block) &&
      !/^checksum\s*=/m.test(block)
  );
  assert.equal(
    rootBlocks.length,
    1,
    `Expected exactly one local ${packageName} package entry without source or checksum in Cargo.lock`
  );
  const [rootBlock] = rootBlocks;
  const version = rootBlock.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  assert.ok(version, `Could not find version for ${packageName} package entry in Cargo.lock`);
  return version;
}

async function readVersionContract(root) {
  const [packageText, cargoToml, cargoLock, tauriText] = await Promise.all([
    fs.readFile(path.join(root, 'package.json'), 'utf8'),
    fs.readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8'),
    fs.readFile(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8'),
    fs.readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  ]);
  return {
    packageJson: JSON.parse(packageText).version,
    cargoToml: extractCargoManifestVersion(cargoToml),
    cargoLock: extractLockPackageVersion(cargoLock),
    tauriConfig: JSON.parse(tauriText).version,
  };
}

export async function assertVersionContract({ root, tag }) {
  const contract = await readVersionContract(root);
  assertSemver(contract.packageJson);
  const sourceLabels = {
    cargoToml: 'Cargo.toml [package]',
    cargoLock: 'Cargo.lock root lightframe package',
    tauriConfig: 'tauri.conf.json',
  };
  for (const [source, version] of Object.entries(contract)) {
    if (source !== 'packageJson') {
      assert.equal(
        version,
        contract.packageJson,
        `${sourceLabels[source]} version differs from package.json`
      );
    }
  }
  if (tag) {
    assert.equal(
      parseReleaseTag(tag),
      contract.packageJson,
      `Release tag ${tag} differs from manifests`
    );
  }
  return contract.packageJson;
}

function replaceSingleVersion(text, expression, version, label) {
  const match = text.match(expression);
  assert.ok(match, `Expected exactly one ${label} version field`);
  return text.replace(expression, `${match[1]}${version}${match[3]}`);
}

export function versionedManifestContents({ packageText, cargoToml, tauriText, version }) {
  assertSemver(version);
  const packageJson = JSON.parse(packageText);
  packageJson.version = version;
  return {
    packageText: `${JSON.stringify(packageJson, null, 2)}\n`,
    cargoToml: replaceSingleVersion(
      cargoToml,
      /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)("\s*$)/m,
      version,
      'Cargo.toml [package]'
    ),
    tauriText: replaceSingleVersion(
      tauriText,
      /(^\s*"version"\s*:\s*")([^"]+)(",?\s*$)/m,
      version,
      'tauri.conf.json'
    ),
  };
}

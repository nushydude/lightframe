import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

function spdxId(name, version) {
  return `SPDXRef-${createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 20)}`;
}

function cargoPackages(lock) {
  return [
    ...lock.matchAll(/\[\[package\]\][\s\S]*?name = "([^"]+)"[\s\S]*?version = "([^"]+)"/g),
  ].map(([, name, version]) => ({ name, version, source: 'cargo' }));
}

function pnpmPackages(lock) {
  const start = lock.indexOf('\npackages:');
  if (start === -1) return [];
  const sectionStart = start + '\npackages:\n'.length;
  const followingSections = lock.slice(sectionStart).search(/^\S[^\n]*:\s*$/m);
  const packageSection = lock.slice(
    sectionStart,
    followingSections === -1 ? undefined : sectionStart + followingSections
  );
  const packages = [];
  for (const match of packageSection.matchAll(/^ {2}(?:(?:'([^']+)')|([^:\n]+)):\s*$/gm)) {
    const key = (match[1] ?? match[2]).trim().replace(/\([^)]*\).*$/, '');
    const separator = key.lastIndexOf('@');
    if (separator <= 0) continue;
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    if (name && version) packages.push({ name, version, source: 'pnpm' });
  }
  return packages;
}

function packagePurl(name, version, source) {
  const ecosystem = source === 'pnpm' ? 'npm' : 'cargo';
  const encodedName = source === 'pnpm' ? name.replace(/^@/, '%40') : name;
  return `pkg:${ecosystem}/${encodedName}@${encodeURIComponent(version)}`;
}

export function createSpdxDocument({ version, cargoLock, pnpmLock }) {
  const dependencies = [...cargoPackages(cargoLock), ...pnpmPackages(pnpmLock)];
  const unique = new Map();
  for (const dependency of dependencies)
    unique.set(`${dependency.source}:${dependency.name}@${dependency.version}`, dependency);
  const packages = [...unique.values()].map(({ name, version: dependencyVersion, source }) => ({
    SPDXID: spdxId(`${source}-${name}`, dependencyVersion),
    name,
    versionInfo: dependencyVersion,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    supplier: 'NOASSERTION',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: packagePurl(name, dependencyVersion, source),
      },
    ],
  }));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `LightFrame-${version}-SBOM`,
    documentNamespace: `https://github.com/nushydude/lightframe/releases/v${version}/sbom`,
    creationInfo: {
      creators: ['Tool: lightframe-generate-release-sbom'],
      created: new Date().toISOString(),
    },
    packages: [
      {
        SPDXID: 'SPDXRef-LightFrame',
        name: 'lightframe',
        versionInfo: version,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        supplier: 'NOASSERTION',
      },
      ...packages,
    ],
    relationships: packages.map((pkg) => ({
      spdxElementId: 'SPDXRef-LightFrame',
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: pkg.SPDXID,
    })),
  };
}

async function main() {
  const output = argument('--output');
  if (!output) throw new Error('Usage: generate-release-sbom.mjs --output <file>');
  const root = path.resolve(import.meta.dirname, '..');
  const [manifest, cargoLock, pnpmLock] = await Promise.all([
    fs.readFile(path.join(root, 'package.json'), 'utf8'),
    fs.readFile(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8'),
    fs.readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
  ]);
  const { version } = JSON.parse(manifest);
  const document = createSpdxDocument({ version, cargoLock, pnpmLock });
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`generated SPDX SBOM with ${document.packages.length - 1} locked dependencies`);
}

if (process.argv[1]?.endsWith('generate-release-sbom.mjs')) await main();

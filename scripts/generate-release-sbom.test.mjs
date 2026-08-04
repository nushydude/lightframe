import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpdxDocument } from './generate-release-sbom.mjs';

test('SBOM includes Cargo and pnpm locked dependencies as SPDX packages', () => {
  const result = createSpdxDocument({
    version: '8.7.6',
    cargoLock: '[[package]]\nname = "image"\nversion = "0.25.0"\n',
    pnpmLock:
      "lockfileVersion: '9.0'\npackages:\n  '@tauri-apps/api@2.11.0':\n    resolution: {}\n  react@19.2.7(peer@1.0.0):\n    resolution: {}\nsnapshots:\n  ignored@1.0.0:\n    resolution: {}\n",
  });
  assert.equal(result.spdxVersion, 'SPDX-2.3');
  assert.equal(result.packages[0].versionInfo, '8.7.6');
  assert.ok(result.packages.some((pkg) => pkg.name === 'image'));
  assert.ok(result.packages.some((pkg) => pkg.name === '@tauri-apps/api'));
  assert.ok(result.packages.some((pkg) => pkg.name === 'react' && pkg.versionInfo === '19.2.7'));
  assert.equal(result.packages.filter((pkg) => pkg.name === 'ignored').length, 0);
  assert.equal(
    result.packages.find((pkg) => pkg.name === 'image').externalRefs[0].referenceType,
    'purl'
  );
});

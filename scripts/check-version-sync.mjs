import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const cargoToml = await fs.readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const tauriConfig = JSON.parse(
  await fs.readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
);

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.equal(packageJson.version, cargoVersion, 'package.json and Cargo.toml versions differ');
assert.equal(packageJson.version, tauriConfig.version, 'package.json and tauri version differ');
console.log(`version metadata synchronized at ${packageJson.version}`);

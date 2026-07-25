import { readFile } from 'node:fs/promises';
import path from 'node:path';

const manifestPath = path.resolve('dist/.vite/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const requiredModules = [
  'src/components/SettingsPanel.tsx',
  'src/components/CommandPalette.tsx',
  'src/components/PerformanceTelemetryOverlay.tsx',
  'src/components/ContactSheet.tsx',
  'src/components/CompareView.tsx',
];

const missing = requiredModules.filter((module) => !manifest[module]);
if (missing.length > 0) {
  throw new Error(
    `Secondary surface modules are missing from the Vite manifest: ${missing.join(', ')}`
  );
}

const entry = manifest['index.html'];
if (!entry?.isEntry) {
  throw new Error('The Vite manifest does not identify index.html as the application entry.');
}

for (const module of requiredModules) {
  const chunk = manifest[module].file;
  if (!chunk || chunk === entry.file) {
    throw new Error(`Secondary surface ${module} was bundled into the initial entry chunk.`);
  }
}

console.log(`Verified ${requiredModules.length} secondary surfaces are split from ${entry.file}.`);

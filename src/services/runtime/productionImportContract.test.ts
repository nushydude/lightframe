import { describe, expect, it } from 'vitest';

const approved = new Set([
  'src/services/runtime/tauriRuntimeAdapter.ts',
  'src/services/tauriCommands.ts',
]);
const forbidden =
  /@tauri-apps\/(api\/(event|window|webviewWindow)|plugin-(dialog|cli|opener|process|updater))/;
const sourceFiles = import.meta.glob('../../**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function sourcePath(file: string) {
  const normalized = file.replace(/\\/g, '/');
  if (normalized.startsWith('../../')) return `src/${normalized.slice(6)}`;
  if (normalized.startsWith('../')) return `src/services/${normalized.slice(3)}`;
  if (normalized.startsWith('./')) return `src/services/runtime/${normalized.slice(2)}`;
  return normalized.replace(/^.*\/src\//, 'src/');
}

describe('production runtime import contract', () => {
  it('keeps Tauri capability imports inside the runtime adapter', () => {
    const violations = Object.entries(sourceFiles)
      .map(([file, source]) => [sourcePath(file), source] as const)
      .filter(([file]) => !file.includes('.test.') && !file.startsWith('src/test/'))
      .filter(([file]) => !approved.has(file))
      .filter(([, source]) => forbidden.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });
});

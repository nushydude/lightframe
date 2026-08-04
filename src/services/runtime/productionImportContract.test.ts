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

describe('production runtime import contract', () => {
  it('keeps Tauri capability imports inside the runtime adapter', () => {
    const violations = Object.entries(sourceFiles)
      .map(
        ([file, source]) =>
          [
            file.replace(/^.*\/src\//, 'src/').replace(/^\.\//, 'src/services/runtime/'),
            source,
          ] as const
      )
      .filter(([file]) => !file.includes('.test.') && !file.startsWith('src/test/'))
      .filter(([file]) => !approved.has(file))
      .filter(([, source]) => forbidden.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });
});

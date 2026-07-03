import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import { mainWindowTitle, projectorWindowTitle } from './windowTitle';

describe('windowTitle', () => {
  it('formats the default app title with the version', () => {
    expect(mainWindowTitle()).toBe(`LightFrame v${packageJson.version}`);
  });

  it('prefixes contextual titles ahead of the versioned app title', () => {
    expect(mainWindowTitle('sample.jpg')).toBe(`sample.jpg - LightFrame v${packageJson.version}`);
  });

  it('formats the projector window title consistently', () => {
    expect(projectorWindowTitle()).toBe(`LightFrame v${packageJson.version} - Projector`);
  });
});

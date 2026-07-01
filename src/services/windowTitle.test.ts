import { describe, expect, it } from 'vitest';
import { mainWindowTitle, projectorWindowTitle } from './windowTitle';

describe('windowTitle', () => {
  it('formats the default app title with the version', () => {
    expect(mainWindowTitle()).toBe('LightFrame v8.1.5');
  });

  it('prefixes contextual titles ahead of the versioned app title', () => {
    expect(mainWindowTitle('sample.jpg')).toBe('sample.jpg - LightFrame v8.1.5');
  });

  it('formats the projector window title consistently', () => {
    expect(projectorWindowTitle()).toBe('LightFrame v8.1.5 - Projector');
  });
});

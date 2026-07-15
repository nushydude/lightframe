import { describe, expect, it } from 'vitest';
import { resolveStartupDecision } from './startup';

describe('resolveStartupDecision', () => {
  it('returns open-image for a non-empty file arg', () => {
    expect(resolveStartupDecision({ value: 'C:/images/photo.jpg' })).toEqual({
      filePath: 'C:/images/photo.jpg',
      folderPath: null,
      mode: 'open-image',
    });
  });

  it('trims file args before deciding startup mode', () => {
    expect(resolveStartupDecision({ value: '   C:/images/photo.jpg   ' })).toEqual({
      filePath: 'C:/images/photo.jpg',
      folderPath: null,
      mode: 'open-image',
    });
  });

  it('returns empty mode when file arg is missing or invalid', () => {
    expect(resolveStartupDecision(undefined)).toEqual({
      filePath: null,
      folderPath: null,
      mode: 'empty',
    });
    expect(resolveStartupDecision({})).toEqual({
      filePath: null,
      folderPath: null,
      mode: 'empty',
    });
    expect(resolveStartupDecision({ value: '' })).toEqual({
      filePath: null,
      folderPath: null,
      mode: 'empty',
    });
    expect(resolveStartupDecision({ value: '   ' })).toEqual({
      filePath: null,
      folderPath: null,
      mode: 'empty',
    });
    expect(resolveStartupDecision({ value: 42 })).toEqual({
      filePath: null,
      folderPath: null,
      mode: 'empty',
    });
  });

  it('opens a folder passed by the taskbar Jump List', () => {
    expect(resolveStartupDecision(undefined, { value: '  C:/Images  ' })).toEqual({
      filePath: null,
      folderPath: 'C:/Images',
      mode: 'open-folder',
    });
  });
});

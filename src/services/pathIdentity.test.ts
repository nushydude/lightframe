import { describe, expect, it } from 'vitest';
import {
  configurePathCaseSemantics,
  configurePathCaseSemanticsForRoot,
  pathIdentityKey,
} from './pathIdentity';

describe('pathIdentityKey', () => {
  it('preserves case on case-sensitive platforms', () => {
    expect(pathIdentityKey('/photos/A.jpg', 'case-sensitive')).not.toBe(
      pathIdentityKey('/photos/a.jpg', 'case-sensitive')
    );
  });

  it('folds case on Windows semantics', () => {
    expect(pathIdentityKey('C:\\Photos\\A.jpg', 'case-insensitive')).toBe(
      pathIdentityKey('c:/photos/a.jpg', 'case-insensitive')
    );
  });

  it('does not infer case folding from Windows-shaped text on a case-sensitive runtime', () => {
    const restore = configurePathCaseSemantics('case-sensitive');
    try {
      expect(pathIdentityKey('C:/Photos/A.jpg')).not.toBe(pathIdentityKey('C:/Photos/a.jpg'));
    } finally {
      restore();
    }
  });

  it('uses the backend-reported semantics of the longest matching authority root', () => {
    configurePathCaseSemanticsForRoot('C:/SensitiveRoot', 'case-sensitive');
    configurePathCaseSemanticsForRoot('C:/SensitiveRoot/Folded', 'case-insensitive');

    expect(pathIdentityKey('C:/SensitiveRoot/A.jpg')).not.toBe(
      pathIdentityKey('C:/SensitiveRoot/a.jpg')
    );
    expect(pathIdentityKey('C:/SensitiveRoot/Folded/A.jpg')).toBe(
      pathIdentityKey('c:/sensitiveroot/folded/a.jpg')
    );
  });

  it('preserves separately registered case-sensitive roots that differ only by case', () => {
    configurePathCaseSemanticsForRoot('C:/Photos/A', 'case-sensitive');
    configurePathCaseSemanticsForRoot('C:/Photos/a', 'case-sensitive');

    expect(pathIdentityKey('C:/Photos/A/image.jpg')).toBe('C:/Photos/A/image.jpg');
    expect(pathIdentityKey('C:/Photos/a/image.jpg')).toBe('C:/Photos/a/image.jpg');
  });
});

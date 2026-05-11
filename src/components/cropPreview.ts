import type { NormalizedCropRect } from '../services/cropMath';

export function getPreviewClipPath(rect: NormalizedCropRect) {
  const top = rect.y * 100;
  const right = 100 - (rect.x + rect.width) * 100;
  const bottom = 100 - (rect.y + rect.height) * 100;
  const left = rect.x * 100;
  return `inset(${top}% ${right}% ${bottom}% ${left}%)`;
}

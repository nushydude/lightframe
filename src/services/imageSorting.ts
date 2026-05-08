import type { ImageFile } from '../types/image';
import type { AppSettings } from '../types/settings';

export function sortImages(images: ImageFile[], sortOrder: AppSettings['sortOrder']): ImageFile[] {
  const sorted = [...images];

  switch (sortOrder) {
    case 'date':
      sorted.sort((a, b) => {
        const da = a.modified_at ? parseInt(a.modified_at, 10) : 0;
        const db = b.modified_at ? parseInt(b.modified_at, 10) : 0;
        return db - da;
      });
      break;
    case 'size':
      sorted.sort((a, b) => b.size_bytes - a.size_bytes);
      break;
    case 'random':
      sorted.sort(() => Math.random() - 0.5);
      break;
    case 'name':
    default:
      break;
  }

  return sorted;
}

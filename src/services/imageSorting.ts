import type { ImageFile } from '../types/image';
import type { AppSettings } from '../types/settings';

const naturalNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function compareByName(a: ImageFile, b: ImageFile): number {
  const nameComparison = naturalNameCollator.compare(a.file_name, b.file_name);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return a.path.localeCompare(b.path);
}

export function sortImages(images: ImageFile[], sortOrder: AppSettings['sortOrder']): ImageFile[] {
  const sorted = [...images];

  switch (sortOrder) {
    case 'name':
      sorted.sort(compareByName);
      break;
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
    default:
      break;
  }

  return sorted;
}

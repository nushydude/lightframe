import type { ImageFile } from '../types/image';
import type { AppSettings } from '../types/settings';

const naturalNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareImagesByName(a: ImageFile, b: ImageFile): number {
  return naturalNameCollator.compare(a.file_name, b.file_name) || a.path.localeCompare(b.path);
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function shuffleImages(
  images: ImageFile[],
  random: () => number = Math.random
): ImageFile[] {
  const shuffled = [...images];
  for (let i = shuffled.length - 1; i >= 1; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function reconcileRandomImages(
  images: ImageFile[],
  previousOrder: string[] | null,
  random: () => number = Math.random
): ImageFile[] {
  if (!previousOrder) return shuffleImages(images, random);
  const byPath = new Map(images.map((image) => [image.path.toLowerCase(), image]));
  const retained = previousOrder
    .map((path) => byPath.get(path.toLowerCase()))
    .filter((image): image is ImageFile => Boolean(image));
  const added = images.filter(
    (image) => !previousOrder.some((path) => path.toLowerCase() === image.path.toLowerCase())
  );
  const result = [...retained];
  for (const image of shuffleImages(added, random)) {
    result.splice(Math.floor(random() * (result.length + 1)), 0, image);
  }
  return result;
}

export function sortImages(
  images: ImageFile[],
  sortOrder: AppSettings['sortOrder'],
  sortDirection: AppSettings['sortDirection'] = sortOrder === 'name' ? 'ascending' : 'descending',
  randomOrder?: string[] | null
): ImageFile[] {
  if (sortOrder === 'random') {
    return randomOrder ? reconcileRandomImages(images, randomOrder) : shuffleImages(images);
  }
  const direction = sortDirection === 'ascending' ? 1 : -1;
  return [...images].sort((a, b) => {
    if (sortOrder === 'name') return compareImagesByName(a, b) * direction;
    if (sortOrder === 'size') {
      const comparison = a.size_bytes - b.size_bytes;
      return comparison * direction || compareImagesByName(a, b);
    } else {
      const field = sortOrder === 'created' ? 'created_at' : 'modified_at';
      const da = parseTimestamp(a[field]);
      const db = parseTimestamp(b[field]);
      if (da == null && db != null) return 1;
      if (da != null && db == null) return -1;
      const comparison = da == null || db == null ? 0 : da - db;
      return comparison * direction || compareImagesByName(a, b);
    }
  });
}

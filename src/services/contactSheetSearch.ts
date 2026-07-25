import type { ImageFile } from '../types/image';

export interface ContactSheetSearchResult {
  image: ImageFile;
  sourceIndex: number;
}

export function normalizeContactSheetPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

export function buildContactSheetResultIndex(
  results: ContactSheetSearchResult[]
): Map<string, number> {
  const index = new Map<string, number>();
  results.forEach(({ image }, resultIndex) => {
    const key = normalizeContactSheetPath(image.path);
    if (index.has(key)) {
      if (import.meta.env.DEV) {
        console.warn(`Duplicate contact-sheet result path: ${image.path}`);
      }
      return;
    }
    index.set(key, resultIndex);
  });
  return index;
}

export function normalizeContactSheetQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function searchContactSheetImages(
  images: ImageFile[],
  query: string
): ContactSheetSearchResult[] {
  const normalizedQuery = normalizeContactSheetQuery(query);

  return images.reduce<ContactSheetSearchResult[]>((results, image, sourceIndex) => {
    if (normalizedQuery === '' || image.file_name.toLowerCase().includes(normalizedQuery)) {
      results.push({ image, sourceIndex });
    }
    return results;
  }, []);
}

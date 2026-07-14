import type { ImageFile } from '../types/image';

export interface ContactSheetSearchResult {
  image: ImageFile;
  sourceIndex: number;
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

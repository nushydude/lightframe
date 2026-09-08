import type { ImageFile } from '../types/image';
import type { ReviewStatus } from '../types/curation';

export type CurationFilter =
  | 'all'
  | 'favorites'
  | 'rated4'
  | 'rated5'
  | 'keep'
  | 'reject'
  | 'unreviewed';

export type CurationStateSnapshot = {
  favorite?: boolean;
  rating?: number;
  reviewStatus?: ReviewStatus;
  updated_at?: number;
};

export const CURATION_FILTER_OPTIONS: Array<{
  value: CurationFilter;
  label: string;
}> = [
  { value: 'all', label: 'All Images' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'rated4', label: '4+ Stars' },
  { value: 'rated5', label: '5 Stars' },
  { value: 'keep', label: 'Keep' },
  { value: 'reject', label: 'Rejected' },
  { value: 'unreviewed', label: 'Unreviewed' },
];

export const SAVED_VIEW_PRESET_OPTIONS = CURATION_FILTER_OPTIONS.filter(
  (option) => option.value !== 'all'
);

export function isCurationFilter(value: unknown): value is CurationFilter {
  return CURATION_FILTER_OPTIONS.some((option) => option.value === value);
}

function normalizedRating(rating: number | undefined): number {
  if (!Number.isFinite(rating)) {
    return 0;
  }

  return Math.max(0, Math.min(5, Math.round(rating ?? 0)));
}

export function isFavoriteCuration(curation: CurationStateSnapshot | undefined): boolean {
  return Boolean(curation?.favorite);
}

export function getReviewStatus(
  curation: CurationStateSnapshot | undefined,
  hasExplicitStatus = true
): ReviewStatus {
  if (
    hasExplicitStatus &&
    (curation?.reviewStatus === 'keep' ||
      curation?.reviewStatus === 'reject' ||
      curation?.reviewStatus === 'unreviewed')
  ) {
    return curation.reviewStatus;
  }

  return isFavoriteCuration(curation) || normalizedRating(curation?.rating) > 0
    ? 'keep'
    : 'unreviewed';
}

export function getReviewStatusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'keep':
      return 'Keep';
    case 'reject':
      return 'Reject';
    case 'unreviewed':
      return 'Unreviewed';
  }
}

function isReviewedCuration(curation: CurationStateSnapshot | undefined): boolean {
  const status = getReviewStatus(curation);
  return status === 'keep' || status === 'reject';
}

export function matchesCurationFilter(
  image: ImageFile,
  filter: CurationFilter,
  curationByPath: Record<string, CurationStateSnapshot>
): boolean {
  const curation = curationByPath[image.path];
  const rating = normalizedRating(curation?.rating);
  const favorite = isFavoriteCuration(curation);
  const reviewStatus = getReviewStatus(curation);

  switch (filter) {
    case 'all':
      return true;
    case 'favorites':
      return favorite;
    case 'rated4':
      return rating >= 4;
    case 'rated5':
      return rating >= 5;
    case 'keep':
      return reviewStatus === 'keep';
    case 'reject':
      return reviewStatus === 'reject';
    case 'unreviewed':
      return reviewStatus === 'unreviewed';
  }
}

function normalizedUpdatedAt(curation: CurationStateSnapshot | undefined): number {
  const value = curation?.updated_at;
  return Number.isFinite(value) ? Number(value) : 0;
}

export function sortImagesForCurationFilter(
  images: ImageFile[],
  filter: CurationFilter,
  curationByPath: Record<string, CurationStateSnapshot>
): ImageFile[] {
  if (filter === 'all' || filter === 'unreviewed' || filter === 'reject' || images.length < 2) {
    return images;
  }

  return [...images].sort((a, b) => {
    const curationA = curationByPath[a.path];
    const curationB = curationByPath[b.path];
    const ratingDifference =
      normalizedRating(curationB?.rating) - normalizedRating(curationA?.rating);
    if (ratingDifference !== 0) {
      return ratingDifference;
    }

    const favoriteDifference =
      Number(isFavoriteCuration(curationB)) - Number(isFavoriteCuration(curationA));
    if (favoriteDifference !== 0) {
      return favoriteDifference;
    }

    const updatedAtDifference = normalizedUpdatedAt(curationB) - normalizedUpdatedAt(curationA);
    if (updatedAtDifference !== 0) {
      return updatedAtDifference;
    }

    return 0;
  });
}

export function getCurationFilterLabel(filter: CurationFilter): string {
  return CURATION_FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? 'All Images';
}

export function getCurationFilterCountLabel(filter: CurationFilter): string {
  switch (filter) {
    case 'all':
      return 'images';
    case 'favorites':
      return 'favorites';
    case 'rated4':
      return '4+ star images';
    case 'rated5':
      return '5-star images';
    case 'keep':
      return 'kept';
    case 'reject':
      return 'rejected';
    case 'unreviewed':
      return 'unreviewed';
  }
}

export function getCurationProgressLabel(
  images: ImageFile[],
  curationByPath: Record<string, CurationStateSnapshot>
): string {
  if (images.length === 0) {
    return '0 reviewed';
  }

  const reviewed = images.reduce(
    (count, image) => count + (isReviewedCuration(curationByPath[image.path]) ? 1 : 0),
    0
  );
  return `${reviewed} of ${images.length} reviewed`;
}

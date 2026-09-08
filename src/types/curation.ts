export type ReviewStatus = 'unreviewed' | 'keep' | 'reject';

export interface ImageCuration {
  path: string;
  favorite: boolean;
  rating: number;
  reviewStatus: ReviewStatus;
  updated_at: number;
}

export interface RustImageCuration {
  path?: unknown;
  favorite?: unknown;
  rating?: unknown;
  review_status?: unknown;
  updated_at?: unknown;
}

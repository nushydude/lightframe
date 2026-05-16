import type { PerformanceMode } from '../types/settings';

const MB = 1024 * 1024;

export type PerformanceModeProfile = {
  previewCacheBudgetBytes: number;
  thumbnailCacheBudgetBytes: number;
  adjacentPreviousImages: number;
  adjacentNextImages: number;
};

export const PERFORMANCE_MODE_LABELS: Record<PerformanceMode, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  lowMemory: 'Low Memory',
};

const PERFORMANCE_MODE_PROFILES: Record<PerformanceMode, PerformanceModeProfile> = {
  fast: {
    previewCacheBudgetBytes: 256 * MB,
    thumbnailCacheBudgetBytes: 160 * MB,
    adjacentPreviousImages: 3,
    adjacentNextImages: 4,
  },
  balanced: {
    previewCacheBudgetBytes: 192 * MB,
    thumbnailCacheBudgetBytes: 104 * MB,
    adjacentPreviousImages: 2,
    adjacentNextImages: 3,
  },
  lowMemory: {
    previewCacheBudgetBytes: 64 * MB,
    thumbnailCacheBudgetBytes: 32 * MB,
    adjacentPreviousImages: 1,
    adjacentNextImages: 1,
  },
};

export function isPerformanceMode(value: unknown): value is PerformanceMode {
  return value === 'fast' || value === 'balanced' || value === 'lowMemory';
}

export function getPerformanceModeProfile(mode: PerformanceMode): PerformanceModeProfile {
  return PERFORMANCE_MODE_PROFILES[mode];
}

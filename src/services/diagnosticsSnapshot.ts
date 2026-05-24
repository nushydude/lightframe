import packageJson from '../../package.json';
import type { PerformanceTelemetrySnapshot } from './performanceTelemetry';
import type { CodecHealthReport } from './tauriCommands';
import type { ImageMetadata } from '../types/image';
import type { AppSettings } from '../types/settings';
import type { CurationFilter } from './curationFilter';

export interface ViewerDiagnosticsState {
  currentImagePath: string | null;
  folderPath: string | null;
  currentIndex: number;
  visibleImageCount: number;
  folderImageCount: number;
  viewMode: 'viewer' | 'grid' | 'compare';
  zoomMode: 'fit' | 'fill' | 'actual' | 'custom';
  zoomLevel: number;
  isFullscreen: boolean;
  isSlideshowActive: boolean;
  isFolderScanning: boolean;
  curationFilter: CurationFilter;
  showPerformanceTelemetry: boolean;
}

export interface DiagnosticsSnapshot {
  schemaVersion: 1;
  collectedAt: string;
  app: {
    name: 'LightFrame';
    version: string;
    mode: string;
    platform: string;
    userAgent: string;
    language: string;
    devicePixelRatio: number;
    windowLabel: string;
  };
  viewer: ViewerDiagnosticsState;
  settings: {
    theme: AppSettings['theme'];
    performanceMode: AppSettings['performanceMode'];
    defaultFitMode: AppSettings['defaultFitMode'];
    mouseWheelBehavior: AppSettings['mouseWheelBehavior'];
    sortOrder: AppSettings['sortOrder'];
    showThumbnails: boolean;
    autoRefreshFolder: boolean;
    rememberWindowBounds: boolean;
    promptProjectorGridOnOpen: boolean;
    openProjectorInGridView: boolean;
    slideshowIntervalSeconds: number;
    loopSlideshow: boolean;
    shuffleSlideshow: boolean;
    autoFullscreenOnSlideshow: boolean;
    savedViewPresets: AppSettings['savedViewPresets'];
    recentFoldersCount: number;
    quickDestinationsCount: number;
    externalEditorConfigured: boolean;
    windowBoundsByDisplayCount: number;
  };
  currentImageMetadata: ImageMetadata | null;
  codecHealth: CodecHealthReport;
  telemetry: PerformanceTelemetrySnapshot;
}

export interface BuildDiagnosticsSnapshotOptions {
  settings: AppSettings;
  viewer: ViewerDiagnosticsState;
  codecHealth: CodecHealthReport;
  telemetry: PerformanceTelemetrySnapshot;
  currentImageMetadata: ImageMetadata | null;
  windowLabel: string;
  collectedAt?: Date;
}

function runtimePlatform(): string {
  const nav = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  return nav.userAgentData?.platform ?? navigator.platform ?? 'unknown';
}

export function buildDiagnosticsSnapshot(
  options: BuildDiagnosticsSnapshotOptions
): DiagnosticsSnapshot {
  const collectedAt = options.collectedAt ?? new Date();

  return {
    schemaVersion: 1,
    collectedAt: collectedAt.toISOString(),
    app: {
      name: 'LightFrame',
      version: packageJson.version,
      mode: import.meta.env.MODE,
      platform: runtimePlatform(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      devicePixelRatio: window.devicePixelRatio,
      windowLabel: options.windowLabel,
    },
    viewer: options.viewer,
    settings: {
      theme: options.settings.theme,
      performanceMode: options.settings.performanceMode,
      defaultFitMode: options.settings.defaultFitMode,
      mouseWheelBehavior: options.settings.mouseWheelBehavior,
      sortOrder: options.settings.sortOrder,
      showThumbnails: options.settings.showThumbnails,
      autoRefreshFolder: options.settings.autoRefreshFolder,
      rememberWindowBounds: options.settings.rememberWindowBounds,
      promptProjectorGridOnOpen: options.settings.promptProjectorGridOnOpen,
      openProjectorInGridView: options.settings.openProjectorInGridView,
      slideshowIntervalSeconds: options.settings.slideshowIntervalSeconds,
      loopSlideshow: options.settings.loopSlideshow,
      shuffleSlideshow: options.settings.shuffleSlideshow,
      autoFullscreenOnSlideshow: options.settings.autoFullscreenOnSlideshow,
      savedViewPresets: options.settings.savedViewPresets,
      recentFoldersCount: options.settings.recentFolders.length,
      quickDestinationsCount: options.settings.quickDestinations.length,
      externalEditorConfigured: Boolean(options.settings.externalEditorPath),
      windowBoundsByDisplayCount: Object.keys(options.settings.windowBoundsByDisplay).length,
    },
    currentImageMetadata: options.currentImageMetadata,
    codecHealth: options.codecHealth,
    telemetry: options.telemetry,
  };
}

export function serializeDiagnosticsSnapshot(snapshot: DiagnosticsSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function buildDiagnosticsFileName(collectedAt = new Date()): string {
  const isoStamp = collectedAt
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\.\d{3}Z$/, 'Z');
  return `lightframe-diagnostics-${isoStamp}.json`;
}

export async function copyDiagnosticsText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

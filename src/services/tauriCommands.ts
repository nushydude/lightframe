import { convertFileSrc as tauriConvertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { ImageFile, ImageMetadata } from '../types/image';
import type { ImageCuration } from '../types/curation';
import type { AppSettings } from '../types/settings';
import { DEFAULT_SETTINGS, settingsFromRust, settingsToRust } from '../types/settings';
import { projectorWindowTitle } from './windowTitle';
import {
  configurePathCaseSemanticsForRoot,
  pathIdentityKey,
  type PathCaseSemantics,
} from './pathIdentity';
export interface ExifData {
  make?: string;
  model?: string;
  software?: string;
  date_time?: string;
  f_number?: number;
  exposure_time?: string;
  iso?: number;
  focal_length?: string;
  raw: Record<string, string>;
}

export interface ImageCaption {
  text: string;
  sidecar_path: string;
  extension: 'txt' | 'caption' | string;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GeneratedImageAsset {
  file_path: string;
  cache_key: string;
  width?: number | null;
  height?: number | null;
  file_size_bytes?: number | null;
}

export interface AuthorizedImageRecord {
  id: string;
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  modified_at?: string | null;
  created_at?: string | null;
}

export interface FolderSessionSnapshot {
  session_id: string;
  session_instance_id?: string;
  canonical_folder: string;
  path_case_semantics?: PathCaseSemantics;
  catalog_revision?: number;
  images: AuthorizedImageRecord[];
}

export interface FileSessionSnapshot {
  session_id: string;
  session_instance_id?: string;
  requested_image_id: string;
  canonical_folder: string;
  path_case_semantics?: PathCaseSemantics;
  catalog_revision?: number;
  images: AuthorizedImageRecord[];
}

interface FolderIndexPayload {
  catalogRevision: number;
  images: ImageFile[];
}

type FolderIndexResponse = FolderIndexPayload | ImageFile[] | null;

function folderIndexImages(payload: FolderIndexResponse): ImageFile[] {
  return Array.isArray(payload) ? payload : (payload?.images ?? []);
}

function folderIndexRevision(payload: FolderIndexResponse): number {
  return Array.isArray(payload) ? 0 : (payload?.catalogRevision ?? 0);
}

export type StartupSessionSelection =
  | { mode: 'empty' }
  | { mode: 'folder'; session: FolderSessionSnapshot }
  | { mode: 'image'; session: FileSessionSnapshot };

type AdoptableSessionSnapshot = FolderSessionSnapshot | FileSessionSnapshot;

class SessionCoordinator {
  private activeSessionId: string | null = null;
  private currentGeneration = 0;
  private winningGeneration = 0;
  private folderSessions = new Map<
    string,
    { generation: number; session: FolderSessionSnapshot; latestCatalogRevision: number }
  >();
  private pendingFolderOpens = new Map<string, Promise<FolderSessionSnapshot>>();
  private activeSessionImages = new Map<string, { sessionId: string; imageId: string }>();
  private projectorGrantOnly = false;

  public getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  public allocateRequestGeneration(): number {
    return ++this.currentGeneration;
  }

  private folderKey(folderPath: string): string {
    return pathIdentityKey(folderPath);
  }

  public getSessionForFolder(folderPath: string): FolderSessionSnapshot | null {
    return this.folderSessions.get(this.folderKey(folderPath))?.session ?? null;
  }

  public getFileSessionForPath(filePath: string): FileSessionSnapshot | null {
    const existingImage = this.getActiveSessionForPath(filePath);
    const existingFolder = this.getSessionForFolder(getParentDirectory(filePath));
    if (
      !existingImage ||
      !existingFolder ||
      existingImage.sessionId !== existingFolder.session_id
    ) {
      return null;
    }

    return {
      session_id: existingFolder.session_id,
      session_instance_id: existingFolder.session_instance_id,
      requested_image_id: existingImage.imageId,
      canonical_folder: existingFolder.canonical_folder,
      path_case_semantics: existingFolder.path_case_semantics,
      catalog_revision: existingFolder.catalog_revision,
      images: existingFolder.images,
    };
  }

  public openFolder(
    folderPath: string,
    opener: () => Promise<FolderSessionSnapshot>
  ): Promise<FolderSessionSnapshot> {
    const requestedKey = this.folderKey(folderPath);
    const pending = this.pendingFolderOpens.get(requestedKey);
    if (pending) return pending;

    const requestGen = this.allocateRequestGeneration();
    const promise = opener()
      .then((session) => {
        const accepted = this.acceptSession(requestGen, session);
        if (!accepted) {
          throw new Error(
            `Folder session request for '${folderPath}' was superseded by a newer request`
          );
        }
        this.folderSessions.set(requestedKey, {
          generation: requestGen,
          session: accepted,
          latestCatalogRevision: accepted.catalog_revision ?? 0,
        });
        return accepted;
      })
      .finally(() => {
        if (this.pendingFolderOpens.get(requestedKey) === promise) {
          this.pendingFolderOpens.delete(requestedKey);
        }
      });
    this.pendingFolderOpens.set(requestedKey, promise);
    return promise;
  }

  public acceptSession(
    requestGen: number,
    session: FolderSessionSnapshot | null | undefined
  ): FolderSessionSnapshot | null {
    if (!session || !session.session_id) {
      return null;
    }

    if (requestGen < this.winningGeneration) {
      this.closeSessionUnlessActive(session);
      return null;
    }

    this.winningGeneration = requestGen;
    this.projectorGrantOnly = false;
    if (session.path_case_semantics) {
      configurePathCaseSemanticsForRoot(session.canonical_folder, session.path_case_semantics);
    }
    const key = this.folderKey(session.canonical_folder || '');
    this.closeReplacedSessions(key, session.session_id);

    this.activeSessionId = session.session_id;
    this.folderSessions.set(key, {
      generation: requestGen,
      session,
      latestCatalogRevision: session.catalog_revision ?? 0,
    });
    this.indexSessionImages(session);

    return session;
  }

  private closeSessionUnlessActive(session: FolderSessionSnapshot): void {
    if (session.session_id !== this.activeSessionId) {
      this.requestSessionClose(session);
    }
  }

  private closeReplacedSessions(folderKey: string, sessionId: string): void {
    const folderSession = this.folderSessions.get(folderKey)?.session;
    if (folderSession && folderSession.session_id !== sessionId) {
      this.requestSessionClose(folderSession);
    }
    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      const activeSession = this.findSession(this.activeSessionId);
      if (activeSession) this.requestSessionClose(activeSession);
    }
  }

  private findSession(sessionId: string): FolderSessionSnapshot | null {
    for (const { session } of this.folderSessions.values()) {
      if (session.session_id === sessionId) return session;
    }
    return null;
  }

  private findSessionEntry(
    sessionId: string
  ): { generation: number; session: FolderSessionSnapshot; latestCatalogRevision: number } | null {
    for (const entry of this.folderSessions.values()) {
      if (entry.session.session_id === sessionId) return entry;
    }
    return null;
  }

  private requestSessionClose(session: FolderSessionSnapshot): void {
    if (!session.session_instance_id) return;
    void invoke('close_folder_session', {
      sessionId: session.session_id,
      sessionInstanceId: session.session_instance_id,
    }).catch(() => {});
  }

  public getSessionInstanceId(sessionId: string): string | null {
    return this.findSession(sessionId)?.session_instance_id ?? null;
  }

  public refreshSessionImages(
    sessionId: string,
    images: ImageFile[],
    catalogRevision = 0
  ): boolean {
    const entry = this.findSessionEntry(sessionId);
    if (!entry) return false;
    if (catalogRevision > 0 && catalogRevision < entry.latestCatalogRevision) {
      return false;
    }
    if (catalogRevision > 0) {
      entry.latestCatalogRevision = catalogRevision;
      entry.session.catalog_revision = catalogRevision;
    }
    const session = entry.session;
    session.images = images.flatMap((image) =>
      image.id
        ? [
            {
              id: image.id,
              path: image.path,
              file_name: image.file_name,
              extension: image.extension,
              size_bytes: image.size_bytes,
              modified_at: image.modified_at,
              created_at: image.created_at,
            },
          ]
        : []
    );
    if (this.activeSessionId === sessionId) this.indexSessionImages(session);
    return true;
  }

  private indexSessionImages(session: FolderSessionSnapshot): void {
    this.activeSessionImages.clear();
    for (const image of session.images ?? []) {
      if (!image?.path || !image.id) continue;
      this.activeSessionImages.set(pathIdentityKey(image.path), {
        sessionId: session.session_id,
        imageId: image.id,
      });
    }
  }

  public getActiveSessionForPath(filePath: string): { sessionId: string; imageId: string } | null {
    if (!filePath) return null;
    const key = pathIdentityKey(filePath);
    const entry = this.activeSessionImages.get(key);
    if (entry && entry.sessionId === this.activeSessionId) {
      return entry;
    }
    return null;
  }

  /** Adopt the backend-issued, single-image projector grant without opening or closing sessions. */
  public adoptProjectorGrant(sessionId: string, image: { id?: string; path: string }): void {
    this.projectorGrantOnly = true;
    this.activeSessionId = sessionId;
    this.activeSessionImages.clear();
    if (sessionId && image.id && image.path) {
      this.activeSessionImages.set(pathIdentityKey(image.path), {
        sessionId,
        imageId: image.id,
      });
    }
  }

  public isProjectorGrantOnly(): boolean {
    return this.projectorGrantOnly;
  }

  public clearProjectorGrant(): void {
    this.activeSessionId = null;
    this.activeSessionImages.clear();
    this.folderSessions.clear();
    this.pendingFolderOpens.clear();
    pendingFolderRefreshes.clear();
    this.projectorGrantOnly = false;
    this.winningGeneration = ++this.currentGeneration;
  }

  public clearActiveSession(sessionId: string): void {
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
  }

  public reset(): void {
    if (this.activeSessionId) {
      const previousSession = this.findSession(this.activeSessionId);
      this.activeSessionId = null;
      if (previousSession) this.requestSessionClose(previousSession);
    }
    this.winningGeneration = ++this.currentGeneration;
    this.folderSessions.clear();
    this.pendingFolderOpens.clear();
    pendingFolderRefreshes.clear();
    this.activeSessionImages.clear();
    this.projectorGrantOnly = false;
  }
}

export const sessionCoordinator = new SessionCoordinator();

export function getActiveSessionForPath(
  filePath: string
): { sessionId: string; imageId: string } | null {
  return sessionCoordinator.getActiveSessionForPath(filePath);
}

export function adoptProjectorGrant(sessionId: string, image: { id?: string; path: string }): void {
  sessionCoordinator.adoptProjectorGrant(sessionId, image);
}

export function isProjectorGrantOnlySession(): boolean {
  return sessionCoordinator.isProjectorGrantOnly();
}

export function clearAdoptedProjectorGrant(): void {
  sessionCoordinator.clearProjectorGrant();
}

export async function openFolderSession(folderPath: string): Promise<FolderSessionSnapshot> {
  return readAuthorizedFolderSessionSnapshot(folderPath);
}

async function readAuthorizedFolderSessionSnapshot(
  folderPath: string
): Promise<FolderSessionSnapshot> {
  const existing = sessionCoordinator.getSessionForFolder(folderPath);
  if (!existing) {
    throw new Error(`No trusted native selection grant exists for folder '${folderPath}'`);
  }
  return existing;
}

export async function openRecentFolderSession(folderPath: string): Promise<FolderSessionSnapshot> {
  const gen = sessionCoordinator.allocateRequestGeneration();
  const session = await invoke<FolderSessionSnapshot>('open_recent_folder_session', { folderPath });
  const accepted = sessionCoordinator.acceptSession(gen, session);
  if (!accepted) throw new Error('Recent-folder session was superseded by a newer request');
  return accepted;
}

async function openFileSession(filePath: string): Promise<FileSessionSnapshot> {
  const existing = readAuthorizedFileSessionSnapshot(filePath);
  if (existing) return existing;
  throw new Error(`No trusted native selection grant exists for file '${filePath}'`);
}

function readAuthorizedFileSessionSnapshot(filePath: string): FileSessionSnapshot | null {
  return sessionCoordinator.getFileSessionForPath(filePath);
}

function acceptNativeSessionSnapshot<T extends AdoptableSessionSnapshot>(
  session: T,
  supersededMessage: string,
  requestGeneration = sessionCoordinator.allocateRequestGeneration()
): T {
  const accepted = sessionCoordinator.acceptSession(requestGeneration, {
    session_id: session.session_id,
    session_instance_id: session.session_instance_id,
    canonical_folder: session.canonical_folder,
    path_case_semantics: session.path_case_semantics,
    catalog_revision: session.catalog_revision,
    images: session.images,
  });
  if (!accepted) throw new Error(supersededMessage);
  return session;
}

export async function selectFolderSession(): Promise<FolderSessionSnapshot | null> {
  const gen = sessionCoordinator.allocateRequestGeneration();
  const session = await invoke<FolderSessionSnapshot | null>('select_folder_session');
  if (!session) return null;
  const accepted = sessionCoordinator.acceptSession(gen, session);
  if (!accepted) throw new Error('Folder selection was superseded by a newer request');
  return accepted;
}

export async function consumeStartupSession(): Promise<StartupSessionSelection> {
  const gen = sessionCoordinator.allocateRequestGeneration();
  const selection = await invoke<StartupSessionSelection>('consume_startup_session');
  if (selection.mode === 'empty') return selection;
  acceptNativeSessionSnapshot(
    selection.session,
    'Startup session was superseded by a newer request',
    gen
  );
  return selection;
}

export function adoptNativeSessionSelection(
  selection: Exclude<StartupSessionSelection, { mode: 'empty' }>
): StartupSessionSelection {
  acceptNativeSessionSnapshot(
    selection.session,
    'Native session selection was superseded by a newer request'
  );
  return selection;
}

export async function selectFileSession(): Promise<FileSessionSnapshot | null> {
  const gen = sessionCoordinator.allocateRequestGeneration();
  const session = await invoke<FileSessionSnapshot | null>('select_file_session');
  if (!session) return null;
  return acceptNativeSessionSnapshot(
    session,
    'File selection was superseded by a newer request',
    gen
  );
}

export async function closeFolderSession(sessionId: string): Promise<void> {
  const sessionInstanceId = sessionCoordinator.getSessionInstanceId(sessionId);
  if (!sessionInstanceId) return;
  sessionCoordinator.clearActiveSession(sessionId);
  await invoke('close_folder_session', { sessionId, sessionInstanceId });
}

export interface NativeDestinationSelection {
  destinationGrantId: string;
  relativeFileName: string;
  selectedPath: string;
  pathCaseSemantics?: PathCaseSemantics;
}
const destinationGrantsByFolder = new Map<string, string>();
const externalEditorGrantsByPath = new Map<string, string>();

function normalizedAuthorityPath(path: string): string {
  return pathIdentityKey(path);
}

export async function selectDestination(
  suggestedFileName: string | undefined,
  operation: 'diagnostics' | 'crop-copy' | 'scale-copy'
): Promise<NativeDestinationSelection | null> {
  const selection = await invoke<NativeDestinationSelection | null>('select_destination', {
    suggestedFileName,
    operation,
  });
  if (selection) {
    if (selection.pathCaseSemantics) {
      configurePathCaseSemanticsForRoot(
        getParentDirectory(selection.selectedPath),
        selection.pathCaseSemantics
      );
    }
    destinationGrantsByFolder.set(
      normalizedAuthorityPath(getParentDirectory(selection.selectedPath)),
      selection.destinationGrantId
    );
  }
  return selection;
}

export interface NativeDestinationFolderSelection {
  destinationGrantId: string;
  selectedPath: string;
  pathCaseSemantics?: PathCaseSemantics;
}

export async function selectDestinationFolder(): Promise<NativeDestinationFolderSelection | null> {
  const selection = await invoke<NativeDestinationFolderSelection | null>(
    'select_destination_folder'
  );
  if (selection) {
    if (selection.pathCaseSemantics) {
      configurePathCaseSemanticsForRoot(selection.selectedPath, selection.pathCaseSemantics);
    }
    destinationGrantsByFolder.set(
      normalizedAuthorityPath(selection.selectedPath),
      selection.destinationGrantId
    );
  }
  return selection;
}

function requireDestinationGrant(folderPath: string): string {
  const grant = destinationGrantsByFolder.get(normalizedAuthorityPath(folderPath));
  if (!grant) throw new Error('Destination requires a trusted native selection');
  return grant;
}

export interface NativeExternalEditorSelection {
  editorGrantId: string;
  selectedPath: string;
  pathCaseSemantics: PathCaseSemantics;
}

export async function selectExternalEditor(): Promise<NativeExternalEditorSelection | null> {
  const selection = await invoke<NativeExternalEditorSelection | null>('select_external_editor');
  if (selection) {
    configurePathCaseSemanticsForRoot(
      getParentDirectory(selection.selectedPath),
      selection.pathCaseSemantics
    );
    externalEditorGrantsByPath.set(
      normalizedAuthorityPath(selection.selectedPath),
      selection.editorGrantId
    );
  }
  return selection;
}

export interface ExecutorTelemetry {
  queued_jobs: number;
  running_jobs: number;
  completed_jobs: number;
  canceled_jobs: number;
  coalesced_jobs: number;
}

export async function cancelMediaRequest(requestId: string): Promise<boolean> {
  return await invoke<boolean>('cancel_media_request', { requestId });
}

export async function getMediaExecutorTelemetry(): Promise<ExecutorTelemetry> {
  return await invoke<ExecutorTelemetry>('get_media_executor_telemetry');
}

interface GeneratedCacheBucket {
  scope: string;
  path: string;
  fileCount: number;
  sizeBytes: number;
}

interface GeneratedCacheSummary {
  buckets: GeneratedCacheBucket[];
  totalFileCount: number;
  totalSizeBytes: number;
  rawNativeFailureCount: number;
}

interface GeneratedAssetRuntimeStats {
  nativePreviewTiming: GeneratedAssetRuntimeTiming;
  rustPreviewTiming: GeneratedAssetRuntimeTiming;
  placeholderPreviewTiming: GeneratedAssetRuntimeTiming;
  nativeTileTiming: GeneratedAssetRuntimeTiming;
  rustTileTiming: GeneratedAssetRuntimeTiming;
  thumbnailCacheHits: number;
  previewCacheHits: number;
  tileCacheHits: number;
  nativeThumbnailGenerations: number;
  nativePreviewGenerations: number;
  rustThumbnailGenerations: number;
  rustPreviewGenerations: number;
  placeholderThumbnailGenerations: number;
  placeholderPreviewGenerations: number;
  tileGenerations: number;
}

interface GeneratedAssetRuntimeTiming {
  sampleCount: number;
  totalMs: number;
  maxMs: number;
}

interface CodecHealthEntry {
  label: string;
  extensions: string[];
  metadataBackend: string;
  thumbnailBackend: string;
  detailBackend: string;
  nativeDecoderAvailable: boolean | null;
  nativeDecoderNames: string[];
  nativeSupportedExtensions: string[];
  nativeMissingExtensions: string[];
  nativeError?: string | null;
  status: string;
  note: string;
}

export interface CodecHealthReport {
  platform: string;
  entries: CodecHealthEntry[];
  generatedCache: GeneratedCacheSummary;
  runtimeStats: GeneratedAssetRuntimeStats;
}

export type GeneratedCacheCommandScope = 'all' | 'thumbnails' | 'previews' | 'tiles';

export interface ImageCurationUpdate {
  filePath: string;
  favorite: boolean;
  rating: number;
}

export interface ImageTransferSuccess {
  sourcePath: string;
  targetPath: string;
  warning?: string;
  sourceRemoved?: boolean;
  committed: boolean;
}

interface ImageTransferFailure {
  sourcePath: string;
  error: string;
  committed: boolean;
  sourceRemoved: boolean;
  warning?: string;
}

interface ImageTransferResult {
  successes: ImageTransferSuccess[];
  failures: ImageTransferFailure[];
}

export type FolderWatcherChangeKind = 'added' | 'removed' | 'modified' | 'renamed';

export interface FolderWatcherChange {
  kind: FolderWatcherChangeKind;
  path: string;
  oldPath?: string | null;
  image?: ImageFile | null;
}

export interface FolderWatcherPayload {
  sessionId: string;
  catalogRevision: number;
  folderPath: string;
  images: ImageFile[];
  changes: FolderWatcherChange[];
  requiresFullRefresh: boolean;
}

const FOLDER_WATCHER_EVENT = 'folder-watcher-changed';

/** Prevent the display from sleeping while a slideshow is running. */
export async function acquireSlideshowDisplayInhibition(): Promise<void> {
  return invoke('acquire_slideshow_display_inhibition');
}

/** Release the slideshow display-sleep inhibition. */
export async function releaseSlideshowDisplayInhibition(): Promise<void> {
  return invoke('release_slideshow_display_inhibition');
}

/** Refresh the Windows taskbar Jump List with recent folders. */
export async function updateRecentFoldersJumpList(): Promise<string[]> {
  return invoke<string[]>('update_recent_folders_jump_list');
}

// fallow-ignore-next-line unused-export -- session-based IPC helper
export async function watchFolderBySession(sessionId: string, watchId: string): Promise<void> {
  return invoke('watch_folder_by_session', { sessionId, watchId });
}

export async function watchFolder(folderPath: string, watchId: string): Promise<void> {
  const session = await openFolderSession(folderPath);
  return watchFolderBySession(session.session_id, watchId);
}

// fallow-ignore-next-line unused-export -- session-based IPC helper
export async function unwatchFolderBySession(watchId?: string): Promise<void> {
  return invoke('unwatch_folder_by_session', { watchId });
}

export async function unwatchFolder(watchId?: string): Promise<void> {
  return unwatchFolderBySession(watchId);
}

/** Listen for debounced active-folder watcher updates */
export async function listenToFolderWatcherChanges(
  onChange: (payload: FolderWatcherPayload) => void
): Promise<UnlistenFn> {
  return listen<FolderWatcherPayload>(FOLDER_WATCHER_EVENT, (event) => {
    if (
      sessionCoordinator.refreshSessionImages(
        event.payload.sessionId,
        event.payload.images,
        event.payload.catalogRevision
      )
    ) {
      onChange(event.payload);
    }
  });
}

/** Scan a folder for supported image files */
export async function scanFolder(folderPath: string): Promise<ImageFile[]> {
  const session = sessionCoordinator.getSessionForFolder(folderPath);
  if (!session) {
    throw new Error(`No trusted native selection grant exists for folder '${folderPath}'`);
  }
  return readFolderIndexBySession(session.session_id);
}

// fallow-ignore-next-line unused-export -- session-based IPC helper
export async function readFolderIndexBySession(sessionId: string): Promise<ImageFile[]> {
  const payload = await invoke<FolderIndexResponse>('read_folder_index_by_session', {
    sessionId,
  });
  const images = folderIndexImages(payload);
  if (!sessionCoordinator.refreshSessionImages(sessionId, images, folderIndexRevision(payload))) {
    throw new Error('Folder index read was superseded by a newer catalog revision');
  }
  return images;
}

export async function readFolderIndex(folderPath: string): Promise<ImageFile[]> {
  const session =
    sessionCoordinator.getSessionForFolder(folderPath) ?? (await openFolderSession(folderPath));
  return readFolderIndexBySession(session.session_id);
}

const pendingFolderRefreshes = new Map<string, Promise<ImageFile[]>>();

export async function refreshFolderIndex(folderPath: string): Promise<ImageFile[]> {
  const session =
    sessionCoordinator.getSessionForFolder(folderPath) ?? (await openFolderSession(folderPath));
  const sessionInstanceId = session.session_instance_id ?? '';
  const refreshKey = `${session.session_id}:${sessionInstanceId}`;
  const pending = pendingFolderRefreshes.get(refreshKey);
  if (pending) return pending;

  const refreshPromise = invoke<FolderIndexResponse>('refresh_folder_index_by_session', {
    sessionId: session.session_id,
  })
    .then((payload) => {
      if (
        sessionInstanceId &&
        sessionCoordinator.getSessionInstanceId(session.session_id) !== sessionInstanceId
      ) {
        throw new Error('Folder refresh was superseded by a newer session instance');
      }
      const images = folderIndexImages(payload);
      if (
        !sessionCoordinator.refreshSessionImages(
          session.session_id,
          images,
          folderIndexRevision(payload)
        )
      ) {
        throw new Error('Folder refresh was superseded by a newer catalog revision');
      }
      return images;
    })
    .finally(() => {
      if (pendingFolderRefreshes.get(refreshKey) === refreshPromise) {
        pendingFolderRefreshes.delete(refreshKey);
      }
    });
  pendingFolderRefreshes.set(refreshKey, refreshPromise);
  const images = await refreshPromise;
  return images;
}

/** Get metadata (dimensions, format, file size) for an image */
export async function getImageMetadata(
  filePath: string,
  requestId?: string
): Promise<ImageMetadata> {
  const sessionInfo = getActiveSessionForPath(filePath);
  if (sessionInfo) {
    return getImageMetadataById(sessionInfo.sessionId, sessionInfo.imageId, requestId);
  }
  const session = await openFileSession(filePath);
  return getImageMetadataById(session.session_id, session.requested_image_id, requestId);
}

// fallow-ignore-next-line unused-export -- session-based IPC helper
export async function getImageCaptionById(
  sessionId: string,
  imageId: string
): Promise<ImageCaption | null> {
  return invoke<ImageCaption | null>('get_image_caption_by_id', { sessionId, imageId });
}

export async function getImageCaption(filePath: string): Promise<ImageCaption | null> {
  const sessionInfo = getActiveSessionForPath(filePath);
  if (sessionInfo) {
    return getImageCaptionById(sessionInfo.sessionId, sessionInfo.imageId);
  }
  const session = await openFileSession(filePath);
  return getImageCaptionById(session.session_id, session.requested_image_id);
}

/** Read codec and generated-cache diagnostics */
export async function getCodecHealth(): Promise<CodecHealthReport> {
  return invoke<CodecHealthReport>('get_codec_health');
}

/** Clear generated preview/thumbnail/tile cache files */
export async function clearGeneratedImageCache(
  scope: GeneratedCacheCommandScope
): Promise<GeneratedCacheSummary> {
  return invoke<GeneratedCacheSummary>('clear_generated_image_cache', { scope });
}

/** Clear native decode negative cache so codecs are retried */
export async function retryNativeCodecs(): Promise<number> {
  return invoke<number>('retry_native_codecs');
}

/** Generate a downscaled preview image and return a cached file-backed asset */
export async function getImageMetadataById(
  sessionId: string,
  imageId: string,
  requestId?: string
): Promise<ImageMetadata> {
  return invoke<ImageMetadata>('get_image_metadata_by_id', { sessionId, imageId, requestId });
}

export async function getPreviewImageById(
  sessionId: string,
  imageId: string,
  maxDimension: number,
  invalidationBust?: number,
  requestId?: string
): Promise<GeneratedImageAsset> {
  return invoke<GeneratedImageAsset>('get_preview_image_by_id', {
    sessionId,
    imageId,
    maxDimension,
    invalidationBust,
    requestId,
  });
}

export async function getThumbnailById(
  sessionId: string,
  imageId: string,
  sizeBytes?: number,
  modifiedAt?: string,
  requestId?: string
): Promise<GeneratedImageAsset> {
  return invoke<GeneratedImageAsset>('get_thumbnail_by_id', {
    sessionId,
    imageId,
    sizeBytes,
    modifiedAt,
    requestId,
  });
}

export async function getImageTileById(
  sessionId: string,
  imageId: string,
  sourceWidth: number,
  sourceHeight: number,
  tileSize: number,
  tileX: number,
  tileY: number,
  requestId?: string
): Promise<GeneratedImageAsset> {
  return invoke<GeneratedImageAsset>('get_image_tile_by_id', {
    sessionId,
    imageId,
    sourceWidth,
    sourceHeight,
    tileSize,
    tileX,
    tileY,
    requestId,
  });
}

/** Get session-aware custom protocol asset URL for full-resolution rendering */
export async function getSessionAssetUrl(sessionId: string, imageId: string): Promise<string> {
  const deliveryId = await invoke<string>('create_asset_delivery', { sessionId, imageId });
  return `lightframe-asset://${sessionId}/${imageId}?deliveryId=${deliveryId}`;
}

interface AssetDeliveryClose {
  closed: boolean;
  responseIds: string[];
}

const finalizedAssetDeliveries = new Set<string>();
const finalizingAssetDeliveries = new Map<string, Promise<boolean>>();
const acknowledgedAssetResponses = new Set<string>();
const MAX_FINALIZED_ASSET_CAPABILITIES = 2_048;

function rememberBounded(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size <= MAX_FINALIZED_ASSET_CAPABILITIES) return;
  const oldest = set.values().next().value;
  if (oldest) set.delete(oldest);
}

async function finalizeSessionAssetDelivery(url: string): Promise<boolean> {
  let deliveryId: string | null = null;
  try {
    deliveryId = new URL(url).searchParams.get('deliveryId');
    if (!deliveryId || finalizedAssetDeliveries.has(deliveryId)) return false;
    const current = finalizingAssetDeliveries.get(deliveryId);
    if (current) return current;

    const finalization = (async () => {
      const closed = await invoke<AssetDeliveryClose>('release_asset_delivery', { deliveryId });
      if (!closed.closed) return false;
      for (const responseId of closed.responseIds) {
        const capability = `${deliveryId}:${responseId}`;
        if (acknowledgedAssetResponses.has(capability)) continue;
        const acknowledged = await invoke<boolean>('acknowledge_asset_delivery_responses', {
          deliveryId,
          responseId,
        });
        if (acknowledged) rememberBounded(acknowledgedAssetResponses, capability);
      }
      rememberBounded(finalizedAssetDeliveries, deliveryId);
      return true;
    })();
    finalizingAssetDeliveries.set(deliveryId, finalization);
    try {
      return await finalization;
    } finally {
      finalizingAssetDeliveries.delete(deliveryId);
    }
  } catch {
    if (deliveryId) finalizingAssetDeliveries.delete(deliveryId);
    return false;
  }
}

export async function releaseSessionAssetDelivery(url: string): Promise<boolean> {
  return finalizeSessionAssetDelivery(url);
}

export async function acknowledgeSessionAssetDeliveryResponses(url: string): Promise<boolean> {
  return finalizeSessionAssetDelivery(url);
}

/** Read persisted application settings */
export async function readSettings(): Promise<AppSettings> {
  if (getCurrentWindow().label === 'secondary') {
    const safe = await invoke<{ theme: string; performanceMode: string }>(
      'read_projector_settings'
    );
    return settingsFromRust({
      ...settingsToRust(DEFAULT_SETTINGS),
      theme: safe.theme,
      performance_mode: safe.performanceMode,
    });
  }
  const raw = await invoke<Record<string, unknown>>('read_settings');
  return settingsFromRust(raw);
}

/** Write application settings to disk */
export async function writeSettings(settings: AppSettings): Promise<void> {
  return invoke('write_settings', { settings: settingsToRust(settings) });
}

/** Save a diagnostics snapshot JSON file */
export async function saveDiagnosticsSnapshot(path: string, content: string): Promise<void> {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const folder = lastSlash >= 0 ? path.slice(0, lastSlash) : '.';
  const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const destinationGrantId = requireDestinationGrant(folder);
  return invoke('save_diagnostics_snapshot', {
    destinationGrantId,
    relativeFileName: fileName,
    content,
  });
}

export async function readCurationMetadataById(
  sessionId: string,
  imageId: string
): Promise<ImageCuration | null> {
  return invoke<ImageCuration | null>('read_curation_metadata_by_id', { sessionId, imageId });
}

export async function readCurationMetadataForIds(
  sessionId: string,
  imageIds: string[]
): Promise<Record<string, ImageCuration>> {
  return invoke<Record<string, ImageCuration>>('read_curation_metadata_for_ids', {
    sessionId,
    imageIds,
  });
}

export async function writeImageCurationById(
  sessionId: string,
  imageId: string,
  favorite: boolean,
  rating: number
): Promise<void> {
  return invoke('write_image_curation_by_id', { sessionId, imageId, favorite, rating });
}

export interface ImageCurationUpdateById {
  imageId: string;
  favorite: boolean;
  rating: number;
}

export async function writeImageCurationBatchById(
  sessionId: string,
  updates: ImageCurationUpdateById[]
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  return invoke('write_image_curation_batch_by_id', { sessionId, updates });
}

export async function clearImageCurationById(sessionId: string, imageId: string): Promise<void> {
  return invoke('clear_image_curation_by_id', { sessionId, imageId });
}

export interface TrashCommitOutcome {
  committed: boolean;
  warning?: string;
}

export async function trashImageById(
  sessionId: string,
  imageId: string
): Promise<TrashCommitOutcome> {
  return invoke('trash_image_by_id', { sessionId, imageId });
}

export async function copyImageById(
  sessionId: string,
  imageId: string,
  destinationGrantId: string
): Promise<string> {
  return invoke<string>('copy_image_by_id', { sessionId, imageId, destinationGrantId });
}

export async function moveImageById(
  sessionId: string,
  imageId: string,
  destinationGrantId: string
): Promise<ImageTransferSuccess> {
  return invoke<ImageTransferSuccess>('move_image_by_id', {
    sessionId,
    imageId,
    destinationGrantId,
  });
}

export async function transferImagesById(
  sessionId: string,
  imageIds: string[],
  destinationGrantId: string,
  mode: 'copy' | 'move'
): Promise<ImageTransferResult> {
  return invoke<ImageTransferResult>('transfer_images_by_id', {
    sessionId,
    imageIds,
    destinationGrantId,
    mode,
  });
}

export async function copyImageByIdToClipboard(sessionId: string, imageId: string): Promise<void> {
  return invoke('copy_image_by_id_to_clipboard', { sessionId, imageId });
}

export async function launchExternalEditorById(
  sessionId: string,
  imageId: string,
  editorGrantId: string
): Promise<void> {
  return invoke('launch_external_editor_by_id', { sessionId, imageId, editorGrantId });
}

export async function getExifMetadataById(sessionId: string, imageId: string): Promise<ExifData> {
  return invoke<ExifData>('get_exif_metadata_by_id', { sessionId, imageId });
}

export async function rotateImageById(
  sessionId: string,
  imageId: string,
  rotationDegrees: number,
  requestId?: string
): Promise<void> {
  return invoke('rotate_image_by_id', { sessionId, imageId, rotationDegrees, requestId });
}

export async function saveCroppedCopyById(
  sessionId: string,
  imageId: string,
  cropRect: CropRect,
  destinationGrantId: string,
  relativeFileName: string,
  rotationDegrees?: number,
  requestId?: string
): Promise<void> {
  return invoke('save_cropped_copy_by_id', {
    sessionId,
    imageId,
    cropRect,
    destinationGrantId,
    relativeFileName,
    rotationDegrees,
    requestId,
  });
}

export async function saveScaledCopyById(
  sessionId: string,
  imageId: string,
  destinationGrantId: string,
  relativeFileName: string,
  width: number,
  height: number,
  smoothing: number,
  sharpening: number,
  requestId?: string
): Promise<void> {
  return invoke('save_scaled_copy_by_id', {
    sessionId,
    imageId,
    destinationGrantId,
    relativeFileName,
    width,
    height,
    smoothing,
    sharpening,
    requestId,
  });
}

export async function overwriteWithCropById(
  sessionId: string,
  imageId: string,
  cropRect: CropRect,
  rotationDegrees?: number,
  requestId?: string
): Promise<void> {
  return invoke('overwrite_with_crop_by_id', {
    sessionId,
    imageId,
    cropRect,
    rotationDegrees,
    requestId,
  });
}

// fallow-ignore-next-line unused-export -- established helper facade
export function getParentDirectory(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/') || '.';
}

export async function getPreviewImage(
  filePath: string,
  maxDimension: number,
  invalidationBust?: number,
  requestId?: string
): Promise<GeneratedImageAsset> {
  const sessionInfo = getActiveSessionForPath(filePath);
  if (sessionInfo) {
    return getPreviewImageById(
      sessionInfo.sessionId,
      sessionInfo.imageId,
      maxDimension,
      invalidationBust,
      requestId
    );
  }
  const session = await openFileSession(filePath);
  return getPreviewImageById(
    session.session_id,
    session.requested_image_id,
    maxDimension,
    invalidationBust,
    requestId
  );
}

export async function getThumbnail(
  filePath: string,
  sizeBytes?: number,
  modifiedAt?: string,
  requestId?: string
): Promise<GeneratedImageAsset> {
  const sessionInfo = getActiveSessionForPath(filePath);
  if (sessionInfo) {
    return getThumbnailById(
      sessionInfo.sessionId,
      sessionInfo.imageId,
      sizeBytes,
      modifiedAt,
      requestId
    );
  }
  const session = await openFileSession(filePath);
  return getThumbnailById(
    session.session_id,
    session.requested_image_id,
    sizeBytes,
    modifiedAt,
    requestId
  );
}

export async function readCurationMetadata(
  filePath?: string
): Promise<Record<string, ImageCuration>> {
  if (!filePath) {
    return {};
  }
  const sessionInfo = getActiveSessionForPath(filePath);
  if (sessionInfo) {
    const curation = await readCurationMetadataById(sessionInfo.sessionId, sessionInfo.imageId);
    return curation ? { [filePath]: curation } : {};
  }
  const session = await openFileSession(filePath);
  const curation = await readCurationMetadataById(session.session_id, session.requested_image_id);
  return curation ? { [filePath]: curation } : {};
}

async function resolveSessionAndImageIdsForPaths(
  paths: string[]
): Promise<{ sessionId: string; imageIds: string[] }> {
  const session = await openFileSession(paths[0]!);
  const pathToId = new Map<string, string>();
  for (const img of session.images) {
    pathToId.set(pathIdentityKey(img.path), img.id);
  }

  const imageIds: string[] = [];
  for (const path of paths) {
    const key = pathIdentityKey(path);
    const imageId = pathToId.get(key);
    if (!imageId) {
      throw new Error(
        `Requested path '${path}' is not authorized in session '${session.session_id}'`
      );
    }
    imageIds.push(imageId);
  }
  return { sessionId: session.session_id, imageIds };
}

export async function readCurationMetadataForPaths(
  filePaths: string[]
): Promise<Record<string, ImageCuration>> {
  if (filePaths.length === 0) {
    return {};
  }
  const byFolder = new Map<string, string[]>();
  for (const path of filePaths) {
    const parent = getParentDirectory(path);
    const existing = byFolder.get(parent) ?? [];
    existing.push(path);
    byFolder.set(parent, existing);
  }

  const combined: Record<string, ImageCuration> = {};
  for (const paths of byFolder.values()) {
    const { sessionId, imageIds } = await resolveSessionAndImageIdsForPaths(paths);
    const res = await readCurationMetadataForIds(sessionId, imageIds);
    Object.assign(combined, res);
  }
  return combined;
}

export async function writeImageCuration(
  filePath: string,
  favorite: boolean,
  rating: number
): Promise<void> {
  const session = await openFileSession(filePath);
  return writeImageCurationById(session.session_id, session.requested_image_id, favorite, rating);
}

export async function writeImageCurationBatch(updates: ImageCurationUpdate[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  const byFolder = new Map<string, ImageCurationUpdate[]>();
  for (const u of updates) {
    const parent = getParentDirectory(u.filePath);
    const existing = byFolder.get(parent) ?? [];
    existing.push(u);
    byFolder.set(parent, existing);
  }

  for (const group of byFolder.values()) {
    const session = await openFileSession(group[0]!.filePath);
    const pathToId = new Map<string, string>();
    for (const img of session.images) {
      pathToId.set(pathIdentityKey(img.path), img.id);
    }

    const byIdUpdates: { imageId: string; favorite: boolean; rating: number }[] = [];
    for (const u of group) {
      const key = pathIdentityKey(u.filePath);
      const imageId = pathToId.get(key);
      if (!imageId) {
        throw new Error(
          `Requested path '${u.filePath}' is not authorized in session '${session.session_id}'`
        );
      }
      byIdUpdates.push({
        imageId,
        favorite: u.favorite,
        rating: u.rating,
      });
    }
    await writeImageCurationBatchById(session.session_id, byIdUpdates);
  }
}

export async function clearImageCuration(filePath: string): Promise<void> {
  const session = await openFileSession(filePath);
  return clearImageCurationById(session.session_id, session.requested_image_id);
}

export async function moveToTrash(filePath: string): Promise<TrashCommitOutcome | void> {
  const session = await openFileSession(filePath);
  return trashImageById(session.session_id, session.requested_image_id);
}

export async function copyImageToClipboard(filePath: string): Promise<void> {
  const session = await openFileSession(filePath);
  return copyImageByIdToClipboard(session.session_id, session.requested_image_id);
}

// fallow-ignore-next-line unused-export -- established IPC facade
export async function launchExternalEditor(
  filePath: string,
  applicationPath: string
): Promise<void> {
  const session = await openFileSession(filePath);
  const editorGrantId = externalEditorGrantsByPath.get(normalizedAuthorityPath(applicationPath));
  if (!editorGrantId) throw new Error('External editor requires a trusted native selection');
  return launchExternalEditorById(session.session_id, session.requested_image_id, editorGrantId);
}

export async function openInExternalApplication(
  filePath: string,
  applicationPath: string
): Promise<void> {
  return launchExternalEditor(filePath, applicationPath);
}

export async function transferImagesToFolder(
  filePaths: string[],
  destinationFolder: string,
  mode: 'copy' | 'move'
): Promise<ImageTransferResult> {
  if (filePaths.length === 0) {
    return { successes: [], failures: [] };
  }
  const destGrantId = requireDestinationGrant(destinationFolder);

  const byFolder = new Map<string, string[]>();
  for (const path of filePaths) {
    const parent = getParentDirectory(path);
    const existing = byFolder.get(parent) ?? [];
    existing.push(path);
    byFolder.set(parent, existing);
  }

  const combinedResult: ImageTransferResult = { successes: [], failures: [] };
  for (const paths of byFolder.values()) {
    const { sessionId, imageIds } = await resolveSessionAndImageIdsForPaths(paths);
    const res = await transferImagesById(sessionId, imageIds, destGrantId, mode);
    combinedResult.successes.push(...res.successes);
    combinedResult.failures.push(...res.failures);
  }
  return combinedResult;
}

export async function getExifMetadata(filePath: string): Promise<ExifData> {
  const session = await openFileSession(filePath);
  return getExifMetadataById(session.session_id, session.requested_image_id);
}

export async function saveRotatedImage(filePath: string, rotationDegrees: number): Promise<void> {
  const session = await openFileSession(filePath);
  return rotateImageById(session.session_id, session.requested_image_id, rotationDegrees);
}

async function prepareImageExportContext(
  filePath: string,
  outputPath: string
): Promise<{ sessionId: string; imageId: string; destGrantId: string; fileName: string }> {
  const session = await openFileSession(filePath);
  const parentDir = getParentDirectory(outputPath);
  const fileName = getFileName(outputPath);
  const destGrantId = requireDestinationGrant(parentDir);
  return {
    sessionId: session.session_id,
    imageId: session.requested_image_id,
    destGrantId,
    fileName,
  };
}

export async function saveCroppedCopy(
  filePath: string,
  cropRect: CropRect,
  outputPath: string,
  rotationDegrees?: number
): Promise<void> {
  const { sessionId, imageId, destGrantId, fileName } = await prepareImageExportContext(
    filePath,
    outputPath
  );
  return saveCroppedCopyById(sessionId, imageId, cropRect, destGrantId, fileName, rotationDegrees);
}

export async function saveCroppedCopyWithGrant(
  filePath: string,
  cropRect: CropRect,
  destinationGrantId: string,
  relativeFileName: string,
  rotationDegrees?: number
): Promise<void> {
  const session = await openFileSession(filePath);
  return saveCroppedCopyById(
    session.session_id,
    session.requested_image_id,
    cropRect,
    destinationGrantId,
    relativeFileName,
    rotationDegrees
  );
}

export async function saveScaledCopy(
  filePath: string,
  outputPath: string,
  width: number,
  height: number,
  smoothing: number,
  sharpening: number
): Promise<void> {
  const { sessionId, imageId, destGrantId, fileName } = await prepareImageExportContext(
    filePath,
    outputPath
  );
  return saveScaledCopyById(
    sessionId,
    imageId,
    destGrantId,
    fileName,
    width,
    height,
    smoothing,
    sharpening
  );
}

export async function saveScaledCopyWithGrant(
  filePath: string,
  destinationGrantId: string,
  relativeFileName: string,
  width: number,
  height: number,
  smoothing: number,
  sharpening: number
): Promise<void> {
  const session = await openFileSession(filePath);
  return saveScaledCopyById(
    session.session_id,
    session.requested_image_id,
    destinationGrantId,
    relativeFileName,
    width,
    height,
    smoothing,
    sharpening
  );
}

export async function overwriteWithCrop(
  filePath: string,
  cropRect: CropRect,
  rotationDegrees?: number
): Promise<void> {
  const session = await openFileSession(filePath);
  return overwriteWithCropById(
    session.session_id,
    session.requested_image_id,
    cropRect,
    rotationDegrees
  );
}

/** Reveal a file in the OS file manager (Windows Explorer, Finder, etc.) */
export async function revealInExplorer(filePath: string): Promise<void> {
  const identity = getActiveSessionForPath(filePath);
  if (!identity) throw new Error('Reveal requires an authorized image identity');
  return invoke('reveal_image_by_id', {
    sessionId: identity.sessionId,
    imageId: identity.imageId,
  });
}

function isSameMonitor(a: Monitor | null, b: Monitor): boolean {
  return (
    a?.name === b.name &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height
  );
}

async function getProjectorMonitor(): Promise<Monitor | null> {
  const monitors = await availableMonitors();
  if (monitors.length === 0) {
    return null;
  }

  if (monitors.length === 1) {
    return monitors[0] ?? null;
  }

  const activeMonitor = await currentMonitor();
  return monitors.find((monitor) => !isSameMonitor(activeMonitor, monitor)) ?? monitors[0] ?? null;
}

async function positionProjectorWindow(webview: WebviewWindow): Promise<void> {
  const monitor = await getProjectorMonitor();
  if (monitor) {
    await webview.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
    await webview.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
  }

  await webview.show();
  await webview.setFocus();
  await webview.setFullscreen(true);
}

function waitForProjectorCreation(webview: WebviewWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    void webview.once('tauri://created', () => resolve());
    void webview.once('tauri://error', (event) => {
      reject(event.payload instanceof Error ? event.payload : new Error(String(event.payload)));
    });
  });
}

/** Open a secondary window for Projector Mode */
export async function openSecondaryWindow(): Promise<void> {
  const label = 'secondary';
  try {
    const existingWebview = await WebviewWindow.getByLabel(label);
    if (existingWebview) {
      await positionProjectorWindow(existingWebview);
      return;
    }

    const webview = new WebviewWindow(label, {
      title: projectorWindowTitle(),
      width: 800,
      height: 600,
      visible: false,
      focus: true,
    });

    await waitForProjectorCreation(webview);
    await positionProjectorWindow(webview);
  } catch (err) {
    console.error('Secondary window error:', err);
    throw err;
  }
}

export async function isSecondaryWindowOpen(): Promise<boolean> {
  return (await WebviewWindow.getByLabel('secondary')) !== null;
}

export async function closeSecondaryWindow(): Promise<void> {
  const webview = await WebviewWindow.getByLabel('secondary');
  if (!webview) {
    return;
  }

  try {
    await webview.setFullscreen(false);
  } catch (err) {
    console.warn('Failed to exit fullscreen before closing projector window:', err);
  }

  await webview.close();
}

/** Emit a sync event to update another window */
export async function emitStateSync(sessionId: string, imageId: string): Promise<void> {
  if (sessionId && imageId) {
    return invoke('emit_projector_sync_by_id', { sessionId, imageId });
  }
  throw new Error('Projector synchronization requires an authorized session and image ID');
}

export async function clearProjectorSync(): Promise<void> {
  return invoke('clear_projector_sync');
}

export interface ProjectorDisplayRecord {
  session_id: string;
  image: ImageFile;
  images: ImageFile[];
  grant_epoch: number;
  navigation_generation: number;
}

export async function readProjectorDisplayRecord(): Promise<ProjectorDisplayRecord> {
  return invoke<ProjectorDisplayRecord>('read_projector_display_record');
}

export async function navigateProjectorImage(
  imageId: string,
  grantEpoch: number,
  navigationGeneration: number
): Promise<ProjectorDisplayRecord> {
  return invoke<ProjectorDisplayRecord>('navigate_projector_image', {
    imageId,
    grantEpoch,
    navigationGeneration,
  });
}

/** Ask the main window to send its current state */
export async function requestStateSync(): Promise<void> {
  return invoke('request_projector_sync');
}

/** Open Windows Default Apps settings */
export async function openSettings(): Promise<void> {
  // On Windows, ms-settings:defaultapps is the most reliable way to let users change defaults
  return openUrl('ms-settings:defaultapps');
}

/** Open a URL in the system's default browser */
export async function openUrlExternal(url: string): Promise<void> {
  return openUrl(url);
}

/** Convert a local file path to a Tauri asset protocol URL */
// fallow-ignore-next-line unused-export -- asset protocol helper
export function convertFileSrc(path: string): string {
  return tauriConvertFileSrc(path);
}

/** Convert a generated cached image asset into a URL with a stable cache-busting token */
export function generatedImageAssetToUrl(asset: GeneratedImageAsset): string {
  const url = new URL(convertFileSrc(asset.file_path));
  url.searchParams.set('v', asset.cache_key);
  return url.toString();
}

/** Extract the parent directory from a file path */
export function getParentFolder(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const uncRootMatch = normalized.match(/^\/\/[^/]+\/[^/]+(?=\/|$)/);
  if (uncRootMatch) {
    if (normalized === uncRootMatch[0]) {
      return filePath;
    }

    const remainder = normalized.slice(uncRootMatch[0].length);
    const remainderSlash = remainder.lastIndexOf('/');
    if (remainderSlash <= 0) {
      return filePath.slice(0, uncRootMatch[0].length);
    }

    return filePath.slice(0, uncRootMatch[0].length + remainderSlash);
  }

  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === '/') {
    return filePath;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '.';
  if (lastSlash === 0) return filePath.slice(0, 1);
  if (lastSlash === 2 && normalized[1] === ':') {
    return filePath.slice(0, 3);
  }
  return filePath.slice(0, lastSlash);
}

/** Get just the filename from a full path */
export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === -1 ? filePath : filePath.substring(lastSlash + 1);
}

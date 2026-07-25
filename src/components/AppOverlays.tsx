import { CurationPersistenceAlert } from './CurationPersistenceAlert';
import { LazySurface } from './LazySurface';
import { ToastViewport } from './ToastViewport';
import { UpdateNotification } from './UpdateNotification';
import type { ViewerCommand } from '../services/commandRegistry';

const loadSettingsPanel = () =>
  import('./SettingsPanel').then(({ SettingsPanel }) => ({ default: SettingsPanel }));
const loadCommandPalette = () =>
  import('./CommandPalette').then(({ CommandPalette }) => ({ default: CommandPalette }));
const loadPerformanceTelemetryOverlay = () =>
  import('./PerformanceTelemetryOverlay').then(({ PerformanceTelemetryOverlay }) => ({
    default: PerformanceTelemetryOverlay,
  }));

interface AppOverlaysProps {
  showSettings: boolean;
  showCommandPalette: boolean;
  commandPaletteCommands: ViewerCommand[];
  onCloseCommandPalette: () => void;
  showPerformanceTelemetry: boolean;
  onResetPerformanceTelemetry: () => void;
  curationError: string | null;
  curationErrorDismissed: boolean;
  onRetryCuration: () => void | Promise<void>;
  onDismissCurationError: () => void;
  errorMessage: string | null;
  onTryNext: () => void;
  onOpenFile: () => void;
  onClearError: () => void;
  isDragOver: boolean;
}

export function AppOverlays({
  showSettings,
  showCommandPalette,
  commandPaletteCommands,
  onCloseCommandPalette,
  showPerformanceTelemetry,
  onResetPerformanceTelemetry,
  curationError,
  curationErrorDismissed,
  onRetryCuration,
  onDismissCurationError,
  errorMessage,
  onTryNext,
  onOpenFile,
  onClearError,
  isDragOver,
}: AppOverlaysProps) {
  return (
    <>
      <AppPanels
        showSettings={showSettings}
        showCommandPalette={showCommandPalette}
        commandPaletteCommands={commandPaletteCommands}
        onCloseCommandPalette={onCloseCommandPalette}
        showPerformanceTelemetry={showPerformanceTelemetry}
        onResetPerformanceTelemetry={onResetPerformanceTelemetry}
      />
      <UpdateNotification />
      <ToastViewport />
      {curationError && !curationErrorDismissed && (
        <CurationPersistenceAlert
          message={curationError}
          onRetry={onRetryCuration}
          onDismiss={onDismissCurationError}
        />
      )}
      {errorMessage && (
        <div className="error-banner" role="alert">
          <span>{errorMessage}</span>
          <button onClick={onTryNext}>Try next</button>
          <button onClick={onOpenFile}>Open file</button>
          <button onClick={onClearError}>&#10005;</button>
        </div>
      )}
      {isDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <span>&#128247;</span>
            <p>Drop image to open</p>
          </div>
        </div>
      )}
    </>
  );
}

function AppPanels({
  showSettings,
  showCommandPalette,
  commandPaletteCommands,
  onCloseCommandPalette,
  showPerformanceTelemetry,
  onResetPerformanceTelemetry,
}: Pick<
  AppOverlaysProps,
  | 'showSettings'
  | 'showCommandPalette'
  | 'commandPaletteCommands'
  | 'onCloseCommandPalette'
  | 'showPerformanceTelemetry'
  | 'onResetPerformanceTelemetry'
>) {
  return (
    <>
      {showSettings && <LazySurface label="Settings" loader={loadSettingsPanel} props={{}} />}
      {showCommandPalette && (
        <LazySurface
          label="Command palette"
          loader={loadCommandPalette}
          props={{
            commands: commandPaletteCommands,
            isOpen: showCommandPalette,
            onClose: onCloseCommandPalette,
          }}
        />
      )}
      {showPerformanceTelemetry && (
        <LazySurface
          label="Performance telemetry"
          loader={loadPerformanceTelemetryOverlay}
          props={{ onReset: onResetPerformanceTelemetry }}
        />
      )}
    </>
  );
}

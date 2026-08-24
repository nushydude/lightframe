import { useEffect, useState } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { useSettingsStore } from '../state/settingsStore';
import { checkUpdateChannel, updateChannelLabel } from '../services/updateService';
import type { UpdateChannel } from '../types/settings';

interface AvailableUpdate {
  version: string;
  body?: string;
  channel: UpdateChannel;
}

type InstallStatus = 'idle' | 'downloading' | 'installError';

function useAvailableUpdate(
  updateChannel: UpdateChannel,
  isSettingsLoaded: boolean
): [AvailableUpdate | null, (update: AvailableUpdate | null) => void] {
  const [updateInfo, setUpdateInfo] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    if (!isSettingsLoaded) {
      return;
    }

    let isCancelled = false;

    async function refreshAvailableUpdate() {
      try {
        const update = await checkUpdateChannel(updateChannel);
        if (isCancelled) {
          return;
        }
        if (update) {
          setUpdateInfo({ version: update.version, body: update.body, channel: updateChannel });
        } else {
          setUpdateInfo(null);
        }
      } catch (err) {
        console.error('Failed to check for updates:', err);
      }
    }

    // Check on mount
    void refreshAvailableUpdate();

    // Check every 4 hours
    const interval = setInterval(refreshAvailableUpdate, 1000 * 60 * 60 * 4);
    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [isSettingsLoaded, updateChannel]);

  return [updateInfo, setUpdateInfo];
}

async function downloadAndInstallChannelUpdate(
  channel: UpdateChannel,
  onProgress: (progress: number) => void
): Promise<boolean> {
  const update = await checkUpdateChannel(channel);
  if (!update) {
    return false;
  }

  let downloaded = 0;
  let contentLength = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength || 0;
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        if (contentLength > 0) {
          onProgress(Math.round((downloaded / contentLength) * 100));
        }
        break;
    }
  });

  await relaunch();
  return true;
}

function shouldShowUpdateNotification(
  updateInfo: AvailableUpdate | null,
  status: InstallStatus
): boolean {
  return updateInfo !== null || status === 'downloading' || status === 'installError';
}

function DownloadingUpdateContent({ progress }: { progress: number }) {
  return (
    <>
      <span className="update-title">Downloading update...</span>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </>
  );
}

function InstallErrorContent({ onDismiss }: { onDismiss: () => void }) {
  return (
    <>
      <span className="update-title">Update failed</span>
      <button className="update-btn" onClick={onDismiss}>
        Dismiss
      </button>
    </>
  );
}

function AvailableUpdateContent({
  updateInfo,
  onUpdate,
  onLater,
}: {
  updateInfo: AvailableUpdate | null;
  onUpdate: () => void;
  onLater: () => void;
}) {
  return (
    <>
      <span className="update-title">
        {updateInfo ? updateChannelLabel(updateInfo.channel) : 'Stable'} update available: v
        {updateInfo?.version}
      </span>
      <div className="update-actions">
        <button className="update-btn primary" onClick={onUpdate}>
          Update & Relaunch
        </button>
        <button className="update-btn" onClick={onLater}>
          Later
        </button>
      </div>
    </>
  );
}

function UpdateNotificationContent({
  status,
  progress,
  updateInfo,
  onUpdate,
  onDismissError,
  onLater,
}: {
  status: InstallStatus;
  progress: number;
  updateInfo: AvailableUpdate | null;
  onUpdate: () => void;
  onDismissError: () => void;
  onLater: () => void;
}) {
  switch (status) {
    case 'downloading':
      return <DownloadingUpdateContent progress={progress} />;
    case 'installError':
      return <InstallErrorContent onDismiss={onDismissError} />;
    default:
      return (
        <AvailableUpdateContent updateInfo={updateInfo} onUpdate={onUpdate} onLater={onLater} />
      );
  }
}

export function UpdateNotification() {
  const updateChannel = useSettingsStore((state) => state.settings.updateChannel);
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded);
  const [updateInfo, setUpdateInfo] = useAvailableUpdate(updateChannel, isSettingsLoaded);
  const [status, setStatus] = useState<InstallStatus>('idle');
  const [progress, setProgress] = useState(0);

  const handleUpdate = async () => {
    const channel = updateInfo?.channel ?? updateChannel;
    try {
      setStatus('downloading');
      setProgress(0);
      const didInstall = await downloadAndInstallChannelUpdate(channel, setProgress);
      setStatus(didInstall ? 'downloading' : 'idle');
    } catch (err) {
      console.error('Failed to install update:', err);
      setStatus('installError');
    }
  };

  if (!shouldShowUpdateNotification(updateInfo, status)) return null;

  return (
    <div className={`update-notification ${status === 'downloading' ? 'busy' : ''}`}>
      <div className="update-content">
        <UpdateNotificationContent
          status={status}
          progress={progress}
          updateInfo={updateInfo}
          onUpdate={handleUpdate}
          onDismissError={() => setStatus('idle')}
          onLater={() => setUpdateInfo(null)}
        />
      </div>
    </div>
  );
}

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

export function UpdateNotification() {
  const updateChannel = useSettingsStore((state) => state.settings.updateChannel);
  const isSettingsLoaded = useSettingsStore((state) => state.isLoaded);
  const [updateInfo, setUpdateInfo] = useState<AvailableUpdate | null>(null);
  const [status, setStatus] = useState<'idle' | 'checking' | 'downloading' | 'installError'>(
    'idle'
  );
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isSettingsLoaded) {
      return;
    }

    let isCancelled = false;

    async function refreshAvailableUpdate() {
      try {
        setStatus('checking');
        const update = await checkUpdateChannel(updateChannel);
        if (isCancelled) {
          return;
        }
        if (update) {
          setUpdateInfo({ version: update.version, body: update.body, channel: updateChannel });
        } else {
          setUpdateInfo(null);
        }
        setStatus('idle');
      } catch (err) {
        console.error('Failed to check for updates:', err);
        if (!isCancelled) {
          setStatus('idle');
        }
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

  const handleUpdate = async () => {
    const channel = updateInfo?.channel ?? updateChannel;
    const update = await checkUpdateChannel(channel);
    if (!update) return;

    try {
      setStatus('downloading');
      setProgress(0);
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
              setProgress(Math.round((downloaded / contentLength) * 100));
            }
            break;
        }
      });

      await relaunch();
    } catch (err) {
      console.error('Failed to install update:', err);
      setStatus('installError');
    }
  };

  if (!updateInfo && status !== 'downloading' && status !== 'installError') return null;

  return (
    <div className={`update-notification ${status === 'downloading' ? 'busy' : ''}`}>
      <div className="update-content">
        {status === 'downloading' ? (
          <>
            <span className="update-title">Downloading update...</span>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </>
        ) : status === 'installError' ? (
          <>
            <span className="update-title">Update failed</span>
            <button className="update-btn" onClick={() => setStatus('idle')}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            <span className="update-title">
              {updateInfo ? updateChannelLabel(updateInfo.channel) : 'Stable'} update available: v
              {updateInfo?.version}
            </span>
            <div className="update-actions">
              <button className="update-btn primary" onClick={handleUpdate}>
                Update & Relaunch
              </button>
              <button className="update-btn" onClick={() => setUpdateInfo(null)}>
                Later
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

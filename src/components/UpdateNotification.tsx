import { useEffect, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null);
  const [status, setStatus] = useState<'idle' | 'checking' | 'downloading' | 'error'>('idle');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    async function checkForUpdates() {
      try {
        setStatus('checking');
        const update = await check();
        if (update) {
          setUpdateInfo({ version: update.version, body: update.body });
        }
        setStatus('idle');
      } catch (err) {
        console.error('Failed to check for updates:', err);
        setStatus('error');
      }
    }

    // Check on mount
    void checkForUpdates();

    // Check every 4 hours
    const interval = setInterval(checkForUpdates, 1000 * 60 * 60 * 4);
    return () => clearInterval(interval);
  }, []);

  const handleUpdate = async () => {
    const update = await check();
    if (!update) return;

    try {
      setStatus('downloading');
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
      setStatus('error');
    }
  };

  if (!updateInfo && status !== 'downloading' && status !== 'error') return null;

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
        ) : status === 'error' ? (
          <>
            <span className="update-title">Update failed</span>
            <button className="update-btn" onClick={() => setStatus('idle')}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            <span className="update-title">New version available: v{updateInfo?.version}</span>
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

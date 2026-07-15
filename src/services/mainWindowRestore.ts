import {
  availableMonitors,
  currentMonitor,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from '@tauri-apps/api/window';
import type { AppSettings } from '../types/settings';
import { displayKeyFromMonitor, windowRestorePlanForDisplays } from './windowBounds';

export async function restoreMainWindowBounds(
  appWindow: {
    setPosition: (position: PhysicalPosition) => Promise<void>;
    setSize: (size: PhysicalSize) => Promise<void>;
  },
  settings: AppSettings,
  canContinue: () => boolean,
  monitorProviders: {
    current: () => Promise<Monitor | null>;
    available: () => Promise<Monitor[]>;
  } = { current: currentMonitor, available: availableMonitors }
): Promise<void> {
  if (!settings.rememberWindowBounds) return;
  const [monitor, monitors] = await Promise.all([
    monitorProviders.current(),
    monitorProviders.available(),
  ]);
  if (!canContinue()) return;

  const restorePlan = windowRestorePlanForDisplays(
    settings,
    displayKeyFromMonitor(monitor),
    monitors
  );
  if (!restorePlan) return;
  await appWindow.setSize(new PhysicalSize(restorePlan.bounds.width, restorePlan.bounds.height));
  if (!canContinue()) return;
  await appWindow.setPosition(new PhysicalPosition(restorePlan.bounds.x, restorePlan.bounds.y));
}

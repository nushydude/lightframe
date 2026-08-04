import type { AppSettings } from '../types/settings';
import { getRuntime } from './runtime/runtime';
import { displayKeyFromMonitor, windowRestorePlanForDisplays } from './windowBounds';

type RuntimeMonitor = NonNullable<
  Awaited<ReturnType<ReturnType<typeof getRuntime>['currentMonitor']>>
>;

export async function restoreMainWindowBounds(
  appWindow: {
    setPosition: (position: { x: number; y: number }) => Promise<void>;
    setSize: (size: { width: number; height: number }) => Promise<void>;
  },
  settings: AppSettings,
  canContinue: () => boolean,
  monitorProviders: {
    current: () => Promise<RuntimeMonitor | null>;
    available: () => Promise<RuntimeMonitor[]>;
  } = {
    current: () => getRuntime().currentMonitor(),
    available: () => getRuntime().availableMonitors(),
  }
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
  await appWindow.setSize({ width: restorePlan.bounds.width, height: restorePlan.bounds.height });
  if (!canContinue()) return;
  await appWindow.setPosition({ x: restorePlan.bounds.x, y: restorePlan.bounds.y });
}

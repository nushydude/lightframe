import packageJson from '../../package.json';

const APP_TITLE = `LightFrame v${packageJson.version}`;

export function mainWindowTitle(context?: string): string {
  const prefix = context?.trim();
  return prefix ? `${prefix} - ${APP_TITLE}` : APP_TITLE;
}

export function projectorWindowTitle(): string {
  return `${APP_TITLE} - Projector`;
}

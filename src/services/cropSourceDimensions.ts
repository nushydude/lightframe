import { getImageMetadata } from './tauriCommands';

function getActiveCanvasImageDimensions(): { width: number; height: number } | null {
  const activeImage = document.querySelector(
    '.image-canvas img:not(.image-full-loader)'
  ) as HTMLImageElement | null;
  const width = activeImage?.naturalWidth ?? activeImage?.width ?? 0;
  const height = activeImage?.naturalHeight ?? activeImage?.height ?? 0;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

export async function getCropSourceDimensions(
  filePath: string
): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await getImageMetadata(filePath);
    if (metadata?.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
  } catch (err) {
    console.warn('Failed to read source dimensions for crop:', err);
  }

  return getActiveCanvasImageDimensions();
}

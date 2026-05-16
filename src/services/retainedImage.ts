export type RetainedImageHandle = HTMLImageElement;

export function retainDecodedImage(url: string): RetainedImageHandle | undefined {
  if (typeof Image === 'undefined') {
    return undefined;
  }

  const image = new Image();
  image.decoding = 'async';
  image.src = url;

  if (typeof image.decode === 'function') {
    void image.decode().catch(() => {
      // Decode failures are surfaced by the visible <img>; cache retention is best-effort.
    });
  }

  return image;
}

export function releaseRetainedDecodedImage(image: RetainedImageHandle | undefined): void {
  if (!image) {
    return;
  }

  image.onload = null;
  image.onerror = null;
  image.removeAttribute('src');
}

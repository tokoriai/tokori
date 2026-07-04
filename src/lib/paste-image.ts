/**
 * Clipboard → image-as-data-URL.
 *
 * Both the card editor and the card creator dialog accept an image
 * paste (Ctrl/Cmd+V from a screenshot, copied browser image, etc.).
 * The conversion logic is the same in both places so it lives here.
 *
 * Returns null when the clipboard event carries no image (e.g. the
 * user just pasted text); callers can then ignore the event.
 */

const MAX_IMAGE_BYTES = 1_500_000;

export type PastedImage = {
  dataUrl: string;
  mime: string;
  /** Approximate size in bytes (data URLs are ~33 % larger than the
   *  raw bytes; this is the data-URL string length, not the decoded
   *  payload, so the cap matches the SQLite TEXT we end up storing). */
  approxBytes: number;
};

export async function imageFromClipboardEvent(
  e: ClipboardEvent,
): Promise<PastedImage | null> {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (!file) continue;
      return readFileAsImage(file);
    }
  }
  return null;
}

export async function readFileAsImage(file: File): Promise<PastedImage | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  return { dataUrl, mime: file.type, approxBytes: dataUrl.length };
}

export function isOversize(img: PastedImage): boolean {
  return img.approxBytes > MAX_IMAGE_BYTES;
}

export const MAX_IMAGE_KB = Math.round(MAX_IMAGE_BYTES / 1000);

// Thin JS wrapper around the Rust `ocr_image` Tauri command. Browser-mode
// (vite dev without Tauri) is unsupported — OCR is a Rust-only feature, so
// we throw a helpful error rather than silently no-op.

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type OcrEvent =
  | { type: "models_downloading"; downloaded: number; total: number; file: string }
  | { type: "recognizing" };

/** Convert a Blob/File of an image to base64. We hand bytes (not a blob URL)
 *  to the Rust side because Tauri's IPC is JSON; binary travels as base64. */
export async function fileToBase64(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const chunk = 0x8000;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Run OCR on an image. `lang` is the workspace target language so we pick
 *  the right recognition model (zh/ja/ko have dedicated models; everything
 *  else falls back to the Latin-charset recognizer). Returns one string
 *  per detected text block in reading order — the caller joins / filters. */
export async function ocrImage(
  blob: Blob,
  lang: string,
  onEvent?: (e: OcrEvent) => void,
): Promise<string[]> {
  if (!isTauri()) {
    throw new Error("OCR requires the desktop app (browser preview can't run local models).");
  }
  const channel = new Channel<OcrEvent>();
  if (onEvent) channel.onmessage = onEvent;
  const imageB64 = await fileToBase64(blob);
  return invoke<string[]>("ocr_image", { imageB64, lang, onEvent: channel });
}

/** One recognised line with its detection polygon (image pixels) + score. */
export type OcrLine = {
  text: string;
  bbox: Array<[number, number]>;
  score: number;
};

/** OCR result with geometry: per-line boxes + the source image dimensions,
 *  so the page-overlay reader can position clickable hotspots over the image
 *  (normalising bbox against width/height). See `linesToWordBoxes`. */
export type OcrLayout = {
  width: number;
  height: number;
  lines: OcrLine[];
};

/** Like {@link ocrImage} but keeps per-line bounding boxes (and the image
 *  size) instead of flattening to text — for the interactive overlay reader.
 *  Same model-download + recognising events as `ocrImage`. */
export async function ocrImageLayout(
  blob: Blob,
  lang: string,
  onEvent?: (e: OcrEvent) => void,
): Promise<OcrLayout> {
  if (!isTauri()) {
    throw new Error("OCR requires the desktop app (browser preview can't run local models).");
  }
  const channel = new Channel<OcrEvent>();
  if (onEvent) channel.onmessage = onEvent;
  const imageB64 = await fileToBase64(blob);
  return invoke<OcrLayout>("ocr_image_layout", { imageB64, lang, onEvent: channel });
}

/** Unicode-range table per language. Used by `keepBlockForLang` to decide
 *  whether an OCR'd block is "in the target language". Only listed for
 *  languages whose script is distinctive enough that filtering by Unicode
 *  range is meaningful — Latin-script languages (en/de/es/fr/it/pt) all
 *  share the same alphabet so a per-block filter would either keep
 *  everything or nothing. */
const SCRIPT_RANGES: Record<string, RegExp> = {
  zh: /[㐀-䶿一-鿿]/,
  ja: /[぀-ゟ゠-ヿ一-鿿]/,
  ko: /[가-힯ᄀ-ᇿ㄰-㆏]/,
  ar: /[؀-ۿݐ-ݿ]/,
  ru: /[Ѐ-ӿ]/,
  el: /[Ͱ-Ͽ]/,
};

export function hasScriptFilter(lang: string): boolean {
  return lang in SCRIPT_RANGES;
}

/** Whether `text` looks like it's in `lang`. We count what fraction of the
 *  letter-bearing characters fall inside the language's script range; a
 *  block is kept if at least 35% match. The threshold is generous because
 *  OCR noise (stray Latin letters in a Chinese block, punctuation,
 *  digits) shouldn't kick out an otherwise-valid line. */
export function keepBlockForLang(text: string, lang: string): boolean {
  const re = SCRIPT_RANGES[lang];
  if (!re) return true; // no filter for this language
  let target = 0;
  let other = 0;
  for (const ch of text) {
    if (re.test(ch)) target++;
    // Count anything that looks like a "letter" in some script as 'other'.
    // Punctuation, whitespace and digits are ignored so a line like
    // "1234" doesn't get classified as "non-target".
    else if (/[\p{L}]/u.test(ch)) other++;
  }
  if (target + other === 0) return false;
  return target / (target + other) >= 0.35;
}

/** Resolve a `file://` URI (what Linux file managers put on the clipboard or
 *  drag data, instead of image bytes) to an image Blob by reading it off disk
 *  through Rust. Returns null in the browser, for non-file URIs, or for
 *  non-image extensions. */
export async function blobFromFileUri(
  uri: string,
): Promise<{ blob: Blob; name: string } | null> {
  if (!isTauri()) return null;
  let path: string;
  try {
    const u = new URL(uri.trim());
    if (u.protocol !== "file:") return null;
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  const name = path.split("/").pop() || "image";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (!["png", "jpg", "jpeg", "webp", "bmp", "gif"].includes(ext)) return null;
  try {
    const b64 = await invoke<string>("read_image_file", { path });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : ext === "bmp"
              ? "image/bmp"
              : "image/jpeg";
    return { blob: new Blob([bytes], { type: mime }), name };
  } catch {
    return null;
  }
}

/** Pull the first image out of a clipboard / drag-drop event. Returns the
 *  Blob and a guess at a sensible default note title from the filename. */
export function extractImage(items: DataTransferItemList | FileList | null): {
  blob: Blob;
  name: string;
} | null {
  if (!items) return null;
  // FileList path (drag-drop): files have names.
  if (items instanceof FileList) {
    for (const f of items) {
      if (f.type.startsWith("image/")) return { blob: f, name: f.name };
    }
    return null;
  }
  // DataTransferItemList path (paste): items rarely have names.
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (!item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) return { blob: f, name: f.name || "Pasted image" };
  }
  return null;
}

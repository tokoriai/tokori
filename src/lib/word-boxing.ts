import type { LanguageCode } from "@/lib/languages";
import type { Segment } from "@/lib/segment";

/**
 * Turning detected/extracted text lines into clickable word hotspots.
 *
 * OCR (PaddleOCR `box_points`) and pdfjs text items both give us *line*-level
 * geometry, but the reader needs *word*-level hotspots. So we take a line's
 * box and subdivide it across the words the tokenizer found inside it. The
 * output is page-relative `[0..1]` so the overlay renders with `%` and stays
 * correct under any zoom / DPI.
 *
 * This module is pure (type-only imports) so it unit-tests under the node
 * env: the async orchestrator takes its tokenizer + width-measurer as
 * parameters rather than importing the Tauri/canvas-bound implementations.
 */

/** A word and its hotspot, in page-relative `[0..1]` coordinates. */
export type WordBox = { text: string; x: number; y: number; w: number; h: number };

/** A plain rectangle in whatever units the caller is working in. */
export type Rect = { x: number; y: number; w: number; h: number };

/** Scripts where reading order runs right-to-left; per-word subdivision by
 *  left-to-right cumulative width would mis-place them, so we fall back to a
 *  single line-level hotspot until a proper RTL path lands. */
const RTL_LANGS = new Set<string>(["ar", "he", "fa", "ur"]);

const isCjk = (lang: LanguageCode): boolean =>
  lang === "zh" || lang === "ja" || lang === "ko";

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Axis-aligned bounding box of an arbitrary set of polygon corners. Robust
 *  to the points not being axis-ordered and to slight detection skew. */
export function aabb(points: ReadonlyArray<readonly [number, number]>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Divide a pixel-space rect by the page dimensions into `[0..1]`, clamped. */
export function normalizeRect(rect: Rect, pageW: number, pageH: number): Rect {
  const W = pageW || 1;
  const H = pageH || 1;
  return {
    x: clamp01(rect.x / W),
    y: clamp01(rect.y / H),
    w: clamp01(rect.w / W),
    h: clamp01(rect.h / H),
  };
}

/** Count grapheme clusters so digraphs / combining marks count as one cell. */
function graphemeCount(s: string, lang: LanguageCode): number {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const seg = new Intl.Segmenter(lang, { granularity: "grapheme" });
    let n = 0;
    for (const _ of seg.segment(s)) n += 1;
    return n;
  }
  return [...s].length;
}

export type SubdivideOpts = {
  lang: LanguageCode;
  /** Text width measurer for proportional (Latin) scripts. Injected so the
   *  module stays canvas-free and testable; defaults to character count. */
  measure?: (s: string) => number;
  /** Force a single line-level hotspot (RTL / low-confidence). */
  lineLevel?: boolean;
};

/**
 * Subdivide a `[0..1]` line box across the word tokens inside it.
 * - CJK: equal grapheme cells (glyphs are ~monospace, so this is accurate).
 * - Latin/spaced: proportional to measured substring width.
 * - RTL / `lineLevel`: one hotspot spanning the whole line.
 * Non-word segments (spaces, punctuation) consume width but get no hotspot.
 */
export function subdivideLine(
  lineBox: Rect,
  segments: ReadonlyArray<Segment>,
  opts: SubdivideOpts,
): WordBox[] {
  const lineLevel = opts.lineLevel || RTL_LANGS.has(opts.lang);
  if (lineLevel) {
    const text = segments.map((s) => s.text).join("").trim();
    return text ? [{ text, ...lineBox }] : [];
  }
  return isCjk(opts.lang)
    ? subdivideByGrapheme(lineBox, segments, opts.lang)
    : subdivideByWidth(lineBox, segments, opts.measure ?? ((s) => s.length));
}

function subdivideByGrapheme(
  lineBox: Rect,
  segments: ReadonlyArray<Segment>,
  lang: LanguageCode,
): WordBox[] {
  const total = segments.reduce((n, s) => n + graphemeCount(s.text, lang), 0);
  if (total === 0) return [];
  const cellW = lineBox.w / total;
  const out: WordBox[] = [];
  let cell = 0;
  for (const s of segments) {
    const n = graphemeCount(s.text, lang);
    if (s.isWord && s.text.trim()) {
      out.push({
        text: s.text,
        x: clamp01(lineBox.x + cell * cellW),
        y: clamp01(lineBox.y),
        w: clamp01(n * cellW),
        h: clamp01(lineBox.h),
      });
    }
    cell += n;
  }
  return out;
}

function subdivideByWidth(
  lineBox: Rect,
  segments: ReadonlyArray<Segment>,
  measure: (s: string) => number,
): WordBox[] {
  const full = segments.map((s) => s.text).join("");
  const totalW = measure(full) || 1;
  const out: WordBox[] = [];
  let acc = "";
  for (const s of segments) {
    const startFrac = measure(acc) / totalW;
    acc += s.text;
    const endFrac = measure(acc) / totalW;
    if (s.isWord && s.text.trim()) {
      out.push({
        text: s.text,
        x: clamp01(lineBox.x + startFrac * lineBox.w),
        y: clamp01(lineBox.y),
        w: clamp01((endFrac - startFrac) * lineBox.w),
        h: clamp01(lineBox.h),
      });
    }
  }
  return out;
}

/** A detected line as it comes off OCR: text + polygon corners in image px. */
export type DetectedLine = { text: string; bbox: ReadonlyArray<readonly [number, number]> };

/**
 * Full pipeline: OCR/extracted lines (pixel polygons) → normalized word
 * hotspots in reading order. The tokenizer is injected (pass `segmentText`)
 * so this stays free of Tauri/cloud imports.
 */
export async function linesToWordBoxes(
  lines: ReadonlyArray<DetectedLine>,
  pageW: number,
  pageH: number,
  lang: LanguageCode,
  tokenize: (text: string, lang: LanguageCode) => Promise<Segment[]>,
  measure?: (s: string) => number,
): Promise<WordBox[]> {
  const out: WordBox[] = [];
  for (const line of lines) {
    const lineBox = normalizeRect(aabb(line.bbox), pageW, pageH);
    const segments = await tokenize(line.text, lang);
    out.push(...subdivideLine(lineBox, segments, { lang, measure }));
  }
  return out;
}

/**
 * Reconstruct the page's running text + each word's offset into it, for the
 * sentence analyzer / cloze. Words are in reading order; CJK joins with no
 * separator, spaced scripts with a single space.
 */
export function pageTextForWords(
  words: ReadonlyArray<WordBox>,
  lang: LanguageCode,
): { pageText: string; offsets: number[] } {
  const sep = isCjk(lang) ? "" : " ";
  const offsets: number[] = [];
  let pageText = "";
  words.forEach((w, i) => {
    offsets.push(pageText.length);
    pageText += w.text + (i < words.length - 1 ? sep : "");
  });
  return { pageText, offsets };
}

/**
 * Lightweight book parser. Takes a PDF or plain-text File, returns chapter
 * objects we can save as reader_documents under a single library_item.
 *
 * EPUB support is queued for a follow-up — it needs a zip extractor + spine
 * walking which is non-trivial. For now we accept .txt and .pdf, which covers
 * the most common "I bought / found / scanned a book" cases.
 *
 * Chapter detection is heuristic. We split on common heading patterns
 *   "Chapter 1", "Chapter 1: …", "第一章", "第1章", "1. Title"
 * and fall back to "the whole book is one chapter" when nothing matches.
 */

export type ParsedChapter = {
  title: string;
  /** 0-indexed position within the book. */
  position: number;
  /** Plain text body (paragraphs separated by blank lines). */
  body: string;
};

export type ParsedBook = {
  title: string;
  chapters: ParsedChapter[];
  /** Total characters across all chapters — used for size estimates. */
  totalChars: number;
};

/** Public entry: hand it any supported File, get a parsed book back. */
export async function parseBook(file: File): Promise<ParsedBook> {
  const lower = file.name.toLowerCase();
  let raw: string;
  if (lower.endsWith(".pdf")) {
    // pdfjs is ~400 kB minified — load it only when someone actually
    // imports a PDF, not as part of the reader/library bundle.
    const { extractPdfText } = await import("./pdf-extract");
    raw = await extractPdfText(file);
  } else if (
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown")
  ) {
    raw = await file.text();
  } else if (lower.endsWith(".epub")) {
    throw new Error(
      "EPUB import is coming soon. For now, export your book to PDF or .txt and try again.",
    );
  } else {
    throw new Error(
      `Unsupported file type: ${file.name}. Try PDF, .txt, or .md.`,
    );
  }
  const cleaned = normalise(raw);
  const fallbackTitle = file.name.replace(/\.(pdf|txt|md|markdown|epub)$/i, "");
  const chapters = splitIntoChapters(cleaned);
  return {
    title: fallbackTitle,
    chapters,
    totalChars: cleaned.length,
  };
}

/** Strip page-number runs, ligatures, and excessive whitespace from raw text. */
function normalise(s: string): string {
  return (
    s
      .replace(/\r\n/g, "\n")
      // Common pdf ligatures.
      .replace(/ﬀ/g, "ff")
      .replace(/ﬁ/g, "fi")
      .replace(/ﬂ/g, "fl")
      .replace(/ﬃ/g, "ffi")
      .replace(/ﬄ/g, "ffl")
      // Lone integer page numbers between blank lines.
      .replace(/\n{2,}\s*\d{1,4}\s*\n{2,}/g, "\n\n")
      // Collapse runs of blank lines down to a max of two.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

const HEADING_RX_LIST: RegExp[] = [
  // "Chapter 1", "Chapter 1: Title", "Chapter One"
  /^\s*chapter\s+(?:[ivxlcdm]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:\s*[:：.\-—]\s*.{0,80})?\s*$/im,
  // Chinese: 第一章, 第1章, 第十二章
  /^\s*第[一-鿿\d]+章(?:\s*[:：.\-—]?\s*.{0,80})?\s*$/im,
  // Japanese same characters; covered by the line above. Plus 第N話 / 第N節.
  /^\s*第[一-鿿\d]+(?:節|話|節)(?:\s*[:：.\-—]?\s*.{0,80})?\s*$/im,
  // Numbered headings: "1. Title", "1 Title" at start of a paragraph.
  /^\s*\d{1,3}[.)。、]\s+.{1,80}\s*$/im,
];

/** Find chapter boundaries via heading patterns. Returns one chapter per match,
 *  or a single "Whole text" chapter if nothing matched. */
function splitIntoChapters(text: string): ParsedChapter[] {
  const lines = text.split("\n");
  const matches: { line: number; title: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 2 || line.length > 100) continue;
    if (HEADING_RX_LIST.some((rx) => rx.test(line))) {
      matches.push({ line: i, title: line });
    }
  }

  if (matches.length < 2) {
    // No clear structure — keep as one chapter.
    return [
      {
        title: "Full text",
        position: 0,
        body: text,
      },
    ];
  }

  const chapters: ParsedChapter[] = [];
  // Skip preamble before the first heading — usually copyright / TOC.
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].line + 1;
    const end = i + 1 < matches.length ? matches[i + 1].line : lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    if (body.length < 80) continue; // skip empty / TOC-like sections
    chapters.push({
      title: matches[i].title,
      position: chapters.length,
      body,
    });
  }
  if (chapters.length === 0) {
    return [{ title: "Full text", position: 0, body: text }];
  }
  return chapters;
}

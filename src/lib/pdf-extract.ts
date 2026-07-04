import * as pdfjsLib from "pdfjs-dist";
// Vite resolves `?url` to a static asset URL — pdfjs needs a worker entry.
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Extract plain text from a PDF File. Returns one string with `\n\n`
 * between pages.
 *
 * Worker fallback: pdfjs-dist's module worker fails to register on
 * some WebKitGTK builds (Tauri's webview on Linux) — the script
 * loads but the message channel never opens, so `getDocument(...)`
 * hangs or rejects with an opaque error. We try the worker path
 * first (fast, off-main-thread), and if it fails we retry with
 * `disableWorker: true` so the parse runs synchronously on the main
 * thread. Slower for big PDFs but always works. The retry is cheap
 * — pdfjs caches the document object across attempts.
 */
async function loadDoc(buf: ArrayBuffer, options: { disableWorker?: boolean }) {
  // `disableWorker` is a runtime-only field — pdfjs reads it but the
  // public DocumentInitParameters type doesn't expose it. Cast so TS
  // accepts the call; this matches the field used in pdfjs's own
  // examples + tests.
  const params = { data: buf, disableWorker: options.disableWorker } as Parameters<
    typeof pdfjsLib.getDocument
  >[0];
  return pdfjsLib.getDocument(params).promise;
}

export async function extractPdfText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let pdf: Awaited<ReturnType<typeof loadDoc>>;
  try {
    pdf = await loadDoc(buf, {});
  } catch (err) {
    console.warn(
      "pdfjs worker failed, falling back to main-thread parse",
      err,
    );
    // The buffer is consumed once getDocument succeeds; on failure
    // it's typically still untouched, but we re-slice defensively
    // because some pdfjs releases transferred ownership.
    const fresh = buf.byteLength > 0 ? buf : await file.arrayBuffer();
    pdf = await loadDoc(fresh, { disableWorker: true });
  }
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const line = tc.items
      .map((it) => ("str" in it ? (it as { str: string }).str : ""))
      .join(" ");
    pages.push(line);
  }
  return pages.join("\n\n");
}

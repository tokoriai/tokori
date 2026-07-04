/**
 * Built-in translation engine registry.
 *
 * Adding an engine:
 *   1. Drop a file in `src/lib/translate/engines/<kind>.ts` exporting a
 *      default `TranslateEngine`.
 *   2. Append it here.
 *   3. Add the kind to the `TranslateKind` union in `./api.ts`.
 *
 * The vocab-import dialog and (later) the click-to-define popover both
 * reach into this registry to pick up an engine implementation by kind.
 */

import type { TranslateEngine, TranslateKind } from "./api";
import googleFree from "./engines/google-free";
import googleCloud from "./engines/google-cloud";
import deepl from "./engines/deepl";
import baidu from "./engines/baidu";
import ai from "./engines/ai";

export const ENGINES: TranslateEngine[] = [
  googleFree, // zero-config fallback — always available
  googleCloud,
  deepl,
  baidu,
  ai,
];

export function engineByKind(kind: TranslateKind): TranslateEngine | null {
  return ENGINES.find((e) => e.meta.kind === kind) ?? null;
}

/** Engine that should run when the user has nothing else configured. The
 *  import dialog falls back to this so "Translate" never silently fails. */
export const FALLBACK_ENGINE: TranslateEngine = googleFree;

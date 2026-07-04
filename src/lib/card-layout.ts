/**
 * Per-card front/back field layout.
 *
 * Each card carries an optional `layout` (JSON in the DB; parsed here)
 * that lists which fields appear on the front and which on the back of
 * the classic flip surfaces (the Browse "open flashcard" preview and
 * the Anki-style study mode). When a card has no stored layout, the
 * default per kind is used — so existing cards keep today's behavior
 * unchanged.
 *
 * Pure helpers only — `<CardFace>` consumes the resolved layout to
 * render. The specialized study modes (KaniWani, sentence cards,
 * sentence-mining, handwriting) keep their bespoke recognition /
 * production flows and don't read this.
 */

import type { VocabKind } from "./db";

/** Atoms a face can render. Image / audio are excluded from defaults
 *  but available as opt-in fields so a learner who relies on a picture
 *  prompt can put `image` on the front. */
export type FieldId =
  | "word"
  | "reading"
  | "definition"
  | "translation"
  | "notes"
  | "image"
  | "audio";

export const ALL_FIELDS: readonly FieldId[] = [
  "word",
  "reading",
  "definition",
  "translation",
  "notes",
  "image",
  "audio",
];

const FIELD_SET: ReadonlySet<string> = new Set<string>(ALL_FIELDS);

export type CardLayout = {
  /** Fields to show on the prompt side, in display order. */
  front: FieldId[];
  /** Fields to reveal on the back, in display order. The renderer
   *  shows `front` again as the prompt above `back` (matches Anki's
   *  "question + answer" reveal). */
  back: FieldId[];
};

/** Default front/back per card kind. `vocab` preserves today's
 *  hardcoded behaviour (Word → Reading + Definition); `sentence` puts
 *  the natural translation first; `writing` is production-direction
 *  (definition prompts the user, the word is the answer). */
export function defaultLayoutForKind(kind: VocabKind): CardLayout {
  switch (kind) {
    case "sentence":
      return { front: ["word"], back: ["translation", "definition"] };
    case "writing":
      return { front: ["definition"], back: ["word", "reading"] };
    case "vocab":
    default:
      return { front: ["word"], back: ["reading", "definition"] };
  }
}

/** Parse the stored JSON layout. Returns null for missing / malformed
 *  input so callers fall back to the kind default. Unknown field ids
 *  are dropped silently — a forward-compat hedge for layouts authored
 *  on a newer schema and read on an older client. */
export function parseLayout(raw: string | null | undefined): CardLayout | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as { front?: unknown; back?: unknown };
  const front = filterFields(obj.front);
  const back = filterFields(obj.back);
  if (front == null || back == null) return null;
  return { front, back };
}

function filterFields(value: unknown): FieldId[] | null {
  if (!Array.isArray(value)) return null;
  const out: FieldId[] = [];
  for (const v of value) {
    if (typeof v === "string" && FIELD_SET.has(v)) {
      out.push(v as FieldId);
    }
  }
  return out;
}

export function serializeLayout(layout: CardLayout): string {
  return JSON.stringify({ front: layout.front, back: layout.back });
}

/** Resolve the effective layout for a card: stored layout when valid,
 *  the kind default otherwise. Callers pass the raw `layout` string off
 *  the card row and its `kind`. */
export function resolveLayout(
  layout: string | null | undefined,
  kind: VocabKind,
): CardLayout {
  return parseLayout(layout) ?? defaultLayoutForKind(kind);
}

/** Equality on layouts — used by the template modal's "save when
 *  changed" guard and by tests. Order-sensitive within each face. */
export function layoutsEqual(a: CardLayout, b: CardLayout): boolean {
  return arrayEq(a.front, b.front) && arrayEq(a.back, b.back);
}

function arrayEq<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

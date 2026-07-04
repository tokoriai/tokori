/**
 * Unit-label helpers for the library's progress controls.
 *
 * `unitLabel` is free text ("pages", "chapters", anything the user
 * types), stored plural because it renders after counts ("12 / 350
 * pages"). Buttons read better singular ("+1 page"), so the known
 * labels get a hand-mapped singular and unknown ones pass through
 * untouched — no naive `s`-stripping on user text.
 *
 * When the unit itself is time ("minutes"), a separate "+10 min"
 * time logger would double-track the same quantity with two buttons;
 * `isMinutesUnit` lets the card collapse them into one stepper that
 * advances both counters together.
 */

const SINGULAR: Record<string, string> = {
  pages: "page",
  chapters: "chapter",
  episodes: "episode",
  minutes: "minute",
  units: "unit",
  lessons: "lesson",
  videos: "video",
  articles: "article",
  words: "word",
};

export function singularUnitLabel(label: string): string {
  return SINGULAR[label.trim().toLowerCase()] ?? label;
}

/** True when the unit label tracks time in minutes ("minutes", "mins",
 *  "min", any casing). */
export function isMinutesUnit(label: string): boolean {
  return /^min(ute)?s?$/i.test(label.trim());
}

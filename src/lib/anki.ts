// AnkiConnect HTTP client. The user runs Anki desktop with the AnkiConnect
// add-on installed (https://ankiweb.net/shared/info/2055492159). It exposes a
// JSON-RPC-ish API on http://localhost:8765. We proxy through Rust because the
// Tauri webview blocks cross-origin fetches to localhost:8765 even when the
// origin would normally be permitted.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./db";

export type AnkiSettings = {
  enabled: boolean;
  endpoint: string;
  deckName: string;
  modelName: string;
  fieldWord: string;
  fieldReading: string;
  fieldGloss: string;
  tag: string;
};

export const DEFAULT_ANKI: AnkiSettings = {
  enabled: false,
  endpoint: "http://localhost:8765",
  deckName: "Tokori",
  modelName: "Basic",
  fieldWord: "Front",
  fieldReading: "",
  fieldGloss: "Back",
  tag: "tokori",
};

const KEYS = {
  enabled: "anki.enabled",
  endpoint: "anki.endpoint",
  deckName: "anki.deckName",
  modelName: "anki.modelName",
  fieldWord: "anki.fieldWord",
  fieldReading: "anki.fieldReading",
  fieldGloss: "anki.fieldGloss",
  tag: "anki.tag",
};

export async function loadAnkiSettings(): Promise<AnkiSettings> {
  const [
    enabled,
    endpoint,
    deckName,
    modelName,
    fieldWord,
    fieldReading,
    fieldGloss,
    tag,
  ] = await Promise.all([
    getSetting(KEYS.enabled),
    getSetting(KEYS.endpoint),
    getSetting(KEYS.deckName),
    getSetting(KEYS.modelName),
    getSetting(KEYS.fieldWord),
    getSetting(KEYS.fieldReading),
    getSetting(KEYS.fieldGloss),
    getSetting(KEYS.tag),
  ]);
  return {
    enabled: enabled === "1",
    endpoint: endpoint || DEFAULT_ANKI.endpoint,
    deckName: deckName || DEFAULT_ANKI.deckName,
    modelName: modelName || DEFAULT_ANKI.modelName,
    fieldWord: fieldWord || DEFAULT_ANKI.fieldWord,
    fieldReading: fieldReading || "",
    fieldGloss: fieldGloss || DEFAULT_ANKI.fieldGloss,
    tag: tag || DEFAULT_ANKI.tag,
  };
}

export async function saveAnkiSettings(s: AnkiSettings): Promise<void> {
  await Promise.all([
    setSetting(KEYS.enabled, s.enabled ? "1" : "0"),
    setSetting(KEYS.endpoint, s.endpoint),
    setSetting(KEYS.deckName, s.deckName),
    setSetting(KEYS.modelName, s.modelName),
    setSetting(KEYS.fieldWord, s.fieldWord),
    setSetting(KEYS.fieldReading, s.fieldReading),
    setSetting(KEYS.fieldGloss, s.fieldGloss),
    setSetting(KEYS.tag, s.tag),
  ]);
}

async function ankiInvoke<T = unknown>(
  endpoint: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!isTauri()) {
    throw new Error("Anki is only available in the desktop app.");
  }
  return invoke<T>("anki_invoke", { endpoint, action, params });
}

export async function ankiVersion(endpoint: string): Promise<number> {
  return ankiInvoke<number>(endpoint, "version");
}

export async function ankiDeckNames(endpoint: string): Promise<string[]> {
  return ankiInvoke<string[]>(endpoint, "deckNames");
}

export async function ankiModelNames(endpoint: string): Promise<string[]> {
  return ankiInvoke<string[]>(endpoint, "modelNames");
}

export async function ankiModelFieldNames(
  endpoint: string,
  modelName: string,
): Promise<string[]> {
  return ankiInvoke<string[]>(endpoint, "modelFieldNames", { modelName });
}

export async function ankiCreateDeck(endpoint: string, deck: string): Promise<number> {
  return ankiInvoke<number>(endpoint, "createDeck", { deck });
}

export type AnkiNoteInput = {
  word: string;
  reading?: string | null;
  gloss?: string | null;
};

/**
 * Add a single note. Returns the new note ID. Throws if the note already
 * exists (AnkiConnect's default behavior with allowDuplicate=false).
 */
export async function ankiAddNote(
  settings: AnkiSettings,
  input: AnkiNoteInput,
): Promise<number> {
  const fields: Record<string, string> = {};
  if (settings.fieldWord) fields[settings.fieldWord] = input.word;
  if (settings.fieldReading && input.reading) fields[settings.fieldReading] = input.reading;
  if (settings.fieldGloss && input.gloss) fields[settings.fieldGloss] = input.gloss;
  // Ensure the deck exists (cheap no-op if it does).
  try {
    await ankiCreateDeck(settings.endpoint, settings.deckName);
  } catch {
    /* ignore */
  }
  return ankiInvoke<number>(settings.endpoint, "addNote", {
    note: {
      deckName: settings.deckName,
      modelName: settings.modelName,
      fields,
      tags: settings.tag ? [settings.tag] : [],
      options: { allowDuplicate: false, duplicateScope: "deck" },
    },
  });
}

export async function ankiFindNotes(
  endpoint: string,
  query: string,
): Promise<number[]> {
  return ankiInvoke<number[]>(endpoint, "findNotes", { query });
}

export type AnkiNoteInfo = {
  noteId: number;
  fields: Record<string, { value: string; order: number }>;
  tags: string[];
  modelName: string;
};

export async function ankiNotesInfo(
  endpoint: string,
  ids: number[],
): Promise<AnkiNoteInfo[]> {
  if (ids.length === 0) return [];
  return ankiInvoke<AnkiNoteInfo[]>(endpoint, "notesInfo", { notes: ids });
}

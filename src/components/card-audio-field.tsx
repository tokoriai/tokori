/**
 * Shared "card audio" UI used by both the card editor and the card
 * creator dialogs. Owns the local audioBytes state, the synthesize +
 * play + clear actions, and renders a compact row of controls.
 *
 * Why split it out:
 *   - Both dialogs need exactly the same widget — repeating ~80 lines
 *     of TTS state machine in two places drifts.
 *   - Lets us add features (waveform preview, language override,
 *     bulk-export) in one place later.
 *
 * State model:
 *   - bytes/mime is a controlled value owned by the parent so it can
 *     persist on save (creator) or update-in-place (editor). When the
 *     parent wants to load existing bytes (editor opens an existing
 *     card with hasAudio), it fetches via `getVocabAudio` and hands
 *     them in.
 *   - The "generate" call writes back via onChange; the parent
 *     decides when those bytes get committed to the DB.
 */

import { useState } from "react";
import { Loader2, Mic, Play, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useTTS } from "@/lib/tts-context";

type Props = {
  /** Word to speak — drives the synthesized audio and the empty-state
   *  button label. Empty word disables the Generate button. */
  word: string;
  /** Language to synthesise in (e.g. "zh", "ja"). Used by the active
   *  TTS provider to pick a voice. */
  lang: string;
  /** Currently-attached audio. null when the card has no cached
   *  audio (or the user just cleared it). */
  bytes: Uint8Array | null;
  mime: string | null;
  onChange: (next: { bytes: Uint8Array | null; mime: string | null }) => void;
};

export function CardAudioField({ word, lang, bytes, mime, onChange }: Props) {
  const tts = useTTS();
  const [generating, setGenerating] = useState(false);
  const [playing, setPlaying] = useState(false);

  async function generate() {
    if (!word.trim()) {
      toast.error("Type a word first");
      return;
    }
    if (tts.config.kind === "browser") {
      toast.error("Browser TTS can't be saved", {
        description:
          "Switch to Edge / OpenAI / ElevenLabs / MiniMax in Settings → Voice to cache audio.",
      });
      return;
    }
    setGenerating(true);
    try {
      const out = await tts.synthesize(word.trim(), lang);
      onChange({ bytes: out.bytes, mime: out.mime });
      toast.success("Audio generated");
    } catch (err) {
      toast.error("Couldn't generate audio", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGenerating(false);
    }
  }

  async function play() {
    if (!bytes) return;
    if (playing) {
      tts.stop();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    try {
      await tts.playCached(bytes, mime ?? "audio/mpeg");
    } catch (err) {
      toast.error("Playback failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPlaying(false);
    }
  }

  function clear() {
    onChange({ bytes: null, mime: null });
  }

  const hasAudio = bytes != null && bytes.byteLength > 0;
  const sizeLabel = hasAudio ? formatBytes(bytes!.byteLength) : null;

  return (
    <div className="space-y-1.5">
      <Label>Audio</Label>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        {hasAudio ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void play()}
              className="h-7 px-2"
            >
              {playing ? (
                <Square className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {playing ? "Stop" : "Play"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              cached · {sizeLabel}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void generate()}
                disabled={generating}
                className="h-7 px-2 text-[11.5px]"
                title="Regenerate"
              >
                {generating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Mic className="size-3" />
                )}
                Regen
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={clear}
                className="h-7 px-2 text-[11.5px] text-muted-foreground hover:text-destructive"
                title="Clear cached audio"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void generate()}
              disabled={generating || !word.trim()}
              className="h-7 px-2"
            >
              {generating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Mic className="size-3.5" />
              )}
              Generate audio
            </Button>
            <span className="text-[11px] text-muted-foreground">
              uses {tts.config.kind === "browser" ? "browser TTS (can't save)" : tts.config.kind}
            </span>
          </>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Cached audio plays instantly during review and works offline.
      </p>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

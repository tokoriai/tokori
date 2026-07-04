import { Loader2, Volume2, VolumeX } from "lucide-react";
import { getVocabAudio } from "@/lib/db";
import { useTTS } from "@/lib/tts-context";
import { cn } from "@/lib/utils";

/**
 * Small icon button that speaks `text` using the configured TTS provider.
 * Re-clicking while audio is playing stops it.
 *
 * When `vocabId` is provided AND that card has cached audio attached
 * (the parent reflects this with `cachedAudioAvailable`), the click
 * plays the cached bytes instead of calling the TTS provider — instant
 * and works offline. Otherwise we fall back to live synthesis on the
 * passed `text`.
 */
export function SpeakButton({
  text,
  lang,
  size = "sm",
  className,
  title = "Read aloud",
  vocabId,
  cachedAudioAvailable,
}: {
  text: string;
  lang?: string;
  size?: "xs" | "sm";
  className?: string;
  title?: string;
  /** When set with `cachedAudioAvailable=true`, click plays the
   *  card's cached audio instead of re-synthesising. */
  vocabId?: number;
  cachedAudioAvailable?: boolean;
}) {
  const tts = useTTS();
  const sizing =
    size === "xs"
      ? "size-6 [&_svg]:size-3"
      : "size-7 [&_svg]:size-3.5";
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        if (tts.busy) {
          tts.stop();
          return;
        }
        if (vocabId != null && cachedAudioAvailable) {
          // Try the cache first — the network call in
          // `tts.speak` would otherwise duplicate work the user
          // already paid for once when they generated the audio.
          const audio = await getVocabAudio(vocabId).catch(() => null);
          if (audio && audio.bytes.byteLength > 0) {
            await tts.playCached(audio.bytes, audio.mime);
            return;
          }
        }
        void tts.speak(text, lang);
      }}
      title={tts.busy ? "Stop" : title}
      className={cn(
        "inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        sizing,
        className,
      )}
    >
      {tts.busy ? (
        <Loader2 className="animate-spin" />
      ) : tts.config.kind === "browser" ? (
        <Volume2 />
      ) : (
        <Volume2 />
      )}
    </button>
  );
}

export function SpeakStopButton({
  text,
  lang,
  className,
}: {
  text: string;
  lang?: string;
  className?: string;
}) {
  const tts = useTTS();
  return (
    <button
      type="button"
      onClick={() => {
        if (tts.busy) tts.stop();
        else void tts.speak(text, lang);
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className,
      )}
      title={tts.busy ? "Stop" : "Speak"}
    >
      {tts.busy ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
    </button>
  );
}

/**
 * Voice preview helpers for the Live Mode picker.
 *
 * Both Gemini Live and OpenAI Realtime ship with prebuilt voice
 * catalogues, but neither lets you "audition" a voice without opening
 * a full WebSocket session. Spinning up the realtime socket just to
 * play 3 seconds of greeting is heavy, so we route previews through
 * each provider's regular (non-realtime) TTS endpoint instead. The
 * voice catalogue overlaps 1:1 with the realtime catalogue:
 *
 *   - OpenAI's `/v1/audio/speech` accepts the same voice names as
 *     Realtime (alloy, ash, ballad, coral, echo, fable, onyx, sage,
 *     shimmer, verse). We piggyback on the existing tts.ts path.
 *   - Gemini's `gemini-2.5-flash-preview-tts:generateContent` accepts
 *     the same prebuilt voices as Live (Aoede, Charon, Fenrir, Kore,
 *     Puck, Leda, Orus, Zephyr). It returns raw PCM (audio/L16) which
 *     we wrap in a WAV header so the standard HTML5 audio element
 *     can play it.
 */

const SAMPLE_TEXT =
  "Hello! I'll be your tutor. Let's practice together.";

// ── Gemini ──

/** Synthesize a sample with one of Gemini's prebuilt Live voices.
 *  Returns playable bytes + mime suitable for `playBytes`. */
export async function previewGeminiVoice(args: {
  apiKey: string;
  voiceName: string;
  /** Optional preview text override. The default is a short English
   *  greeting that exercises voice timbre without language coverage —
   *  callers can pass a target-language phrase for a more relevant
   *  audition. */
  text?: string;
}): Promise<{ bytes: Uint8Array; mime: string }> {
  const text = args.text || SAMPLE_TEXT;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(args.apiKey)}`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: args.voiceName },
        },
      },
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Gemini TTS ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const part = data?.candidates?.[0]?.content?.parts?.find(
    (p: any) => p.inlineData?.data,
  );
  if (!part) throw new Error("Gemini returned no audio");
  // mimeType comes back like "audio/L16;codec=pcm;rate=24000".
  const mimeRaw: string = part.inlineData.mimeType ?? "";
  const rate = parseSampleRate(mimeRaw) ?? 24000;
  const pcm = base64ToBytes(part.inlineData.data as string);
  // Wrap raw PCM16 in a WAV container so HTMLAudio plays it. WAV has
  // a 44-byte header followed by raw PCM bytes — trivial to write,
  // no third-party encoder needed.
  const wav = pcm16ToWav(pcm, rate, 1);
  return { bytes: wav, mime: "audio/wav" };
}

// ── OpenAI ──

/** Same shape as the Gemini helper, but routes through OpenAI's
 *  regular TTS endpoint. Models that accept the realtime voice names
 *  include `gpt-4o-mini-tts`, `tts-1`, and `tts-1-hd`; we use the
 *  cheapest. */
export async function previewOpenAIVoice(args: {
  apiKey: string;
  voiceName: string;
  text?: string;
}): Promise<{ bytes: Uint8Array; mime: string }> {
  const text = args.text || SAMPLE_TEXT;
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: args.voiceName,
      input: text,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OpenAI TTS ${r.status}: ${txt.slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  return { bytes: new Uint8Array(buf), mime: "audio/mpeg" };
}

// ── Helpers ──

function parseSampleRate(mime: string): number | null {
  const m = mime.match(/rate=(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Wrap raw 16-bit PCM in a minimal WAV container. */
function pcm16ToWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
): Uint8Array {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcm.byteLength;
  const totalSize = 44 + dataSize;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  // RIFF header — see the WAV spec, every field is little-endian
  // except the "RIFF"/"WAVE"/"fmt "/"data" magic markers.
  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(out, 36, "data");
  view.setUint32(40, dataSize, true);
  out.set(pcm, 44);
  return out;
}

function writeAscii(arr: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) arr[offset + i] = str.charCodeAt(i);
}

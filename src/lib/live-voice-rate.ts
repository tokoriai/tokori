/**
 * Shared playback rate for the live-voice backends.
 *
 * A module-level mutable cell rather than React state: the five live
 * hooks (gemini / openai / qwen / cloud / local) each own their own
 * playback pipeline, and threading a rate prop through every
 * `start()` signature would churn five APIs for one knob. Instead the
 * pipelines read this cell at the moment they start a chunk, so a
 * mid-session change applies from the very next chunk (~1 s).
 *
 * Pitch: the HTMLAudioElement pipelines (gemini / cloud / local) keep
 * pitch via `preservesPitch`; the AudioBufferSourceNode pipelines
 * (openai / qwen) shift pitch slightly with the rate — that's inherent
 * to `AudioBufferSourceNode.playbackRate`, and acceptable in the
 * 0.75–1.5× band this UI offers.
 */
export const liveVoiceRate = { current: 1 };

export const LIVE_VOICE_RATES = [0.75, 0.9, 1, 1.25, 1.5] as const;

/**
 * Minimal ElevenLabs HTTP client for the TTS endpoint, scoped to what the
 * `tts --provider elevenlabs` flow needs:
 *
 * - text → audio bytes for a single chunk
 * - returns the `request-id` response header so callers can chain it via
 *   `previous_request_ids` for prosody-coherent stitching
 * - returns audio in `pcm_44100` (raw 16-bit mono LE) by default so chunks
 *   concatenate losslessly
 *
 * We deliberately avoid the `elevenlabs` npm package — Node 22 has fetch
 * built-in, the surface we need is tiny, and pulling in a dep for one POST
 * isn't worth the install-time cost in a CLI.
 */

import { Buffer } from "node:buffer";

export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

/** Output audio formats we expose. Names match the ElevenLabs `output_format` query param. */
export type AudioFormat =
  | "pcm_44100"
  | "pcm_24000"
  | "pcm_22050"
  | "pcm_16000"
  | "mp3_44100_192"
  | "mp3_44100_128"
  | "mp3_44100_64";

/** Models we support. New IDs can be added without code changes — the model is forwarded as-is. */
export const ELEVENLABS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_flash_v2_5",
  "eleven_v3",
] as const;
export type ElevenLabsModel = (typeof ELEVENLABS_MODELS)[number];

export const DEFAULT_MODEL: ElevenLabsModel = "eleven_multilingual_v2";

/**
 * ElevenLabs "Rachel" — a stable, public, English voice that ships with
 * every account. Safe default when the user hasn't picked one yet.
 */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export interface VoiceSettings {
  /** 0-1, higher = more consistent, lower = more expressive. */
  stability?: number;
  /** 0-1, similarity to the source voice. 0.75 is the API default. */
  similarity_boost?: number;
  /** 0-1, expressive style exaggeration. 0 keeps neutral delivery. */
  style?: number;
  /** Adds a perceived presence boost. Default true on most voices. */
  use_speaker_boost?: boolean;
}

export interface SynthesizeChunkOptions {
  voiceId: string;
  text: string;
  modelId: ElevenLabsModel;
  outputFormat: AudioFormat;
  voiceSettings: VoiceSettings;
  /**
   * Up to 3 request IDs from prior chunks in this same generation. ElevenLabs
   * conditions the new generation on the audio those requests produced —
   * this is the mechanism that makes long narrations cohere prosodically.
   */
  previousRequestIds?: string[];
  /** Plain text of the prior chunk(s); cheaper context than request IDs. */
  previousText?: string;
  /** Plain text of the next chunk; lets the model phrase the ending naturally. */
  nextText?: string;
  /** Deterministic generation when set. Same seed + text + settings = same audio. */
  seed?: number;
  /**
   * 'auto' lets ElevenLabs expand numbers/abbreviations; 'off' disables that
   * for callers that pre-normalize (the hyperframes flow does — see narration.md).
   */
  applyTextNormalization?: "auto" | "on" | "off";
  /** Bearer key. Required. */
  apiKey: string;
  /** Override the API base for tests. */
  apiBase?: string;
  /** Aborts the request when fired. */
  signal?: AbortSignal;
}

export interface SynthesizeChunkResult {
  audio: Buffer;
  /** The `request-id` response header — pass into the next chunk's `previousRequestIds`. */
  requestId: string | null;
}

export class ElevenLabsApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ElevenLabsApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * POST /v1/text-to-speech/{voice_id}?output_format=...
 *
 * Returns the raw audio bytes for the given format. For `pcm_*` formats the
 * body is little-endian 16-bit mono PCM with no header — concatenation is
 * just byte concatenation. For mp3 formats the body is a complete MP3 file.
 */
export async function synthesizeChunk(
  opts: SynthesizeChunkOptions,
): Promise<SynthesizeChunkResult> {
  const base = opts.apiBase ?? ELEVENLABS_API_BASE;
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=${encodeURIComponent(opts.outputFormat)}`;

  const body: Record<string, unknown> = {
    text: opts.text,
    model_id: opts.modelId,
    voice_settings: opts.voiceSettings,
  };
  if (opts.previousRequestIds && opts.previousRequestIds.length > 0) {
    body["previous_request_ids"] = opts.previousRequestIds.slice(-3);
  }
  if (opts.previousText) body["previous_text"] = opts.previousText;
  if (opts.nextText) body["next_text"] = opts.nextText;
  if (typeof opts.seed === "number") body["seed"] = opts.seed;
  if (opts.applyTextNormalization) {
    body["apply_text_normalization"] = opts.applyTextNormalization;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": opts.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/*",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ElevenLabsApiError(
      `ElevenLabs request failed: HTTP ${response.status}`,
      response.status,
      text.slice(0, 1000),
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const requestId = response.headers.get("request-id");

  return { audio: Buffer.from(arrayBuffer), requestId };
}

/** GET /v1/voices — returns the voices visible to the current API key. */
export interface RemoteVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  description?: string;
}

export async function listVoices(opts: {
  apiKey: string;
  apiBase?: string;
  signal?: AbortSignal;
}): Promise<RemoteVoice[]> {
  const base = opts.apiBase ?? ELEVENLABS_API_BASE;
  const response = await fetch(`${base}/v1/voices`, {
    headers: { "xi-api-key": opts.apiKey, Accept: "application/json" },
    signal: opts.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ElevenLabsApiError(
      `Failed to list voices: HTTP ${response.status}`,
      response.status,
      text.slice(0, 500),
    );
  }
  const data = (await response.json()) as { voices?: RemoteVoice[] };
  return data.voices ?? [];
}

/**
 * Wrap a buffer of raw 16-bit mono LE PCM samples in a canonical RIFF/WAVE
 * header so other tools (FFmpeg, players) can read it directly.
 */
export function wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Map a `pcm_NNNNN` format string to its sample rate. */
export function sampleRateFromFormat(format: AudioFormat): number {
  const match = format.match(/^pcm_(\d+)$/);
  if (match) return parseInt(match[1] ?? "44100", 10);
  if (format.startsWith("mp3_44100")) return 44100;
  return 44100;
}

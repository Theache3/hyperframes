/**
 * High-level synthesize() for the `tts --provider elevenlabs` flow:
 *
 *   text → chunks → ElevenLabs per chunk (stitched) → concat → loudnorm → wav
 *
 * Stitching strategy:
 *   - `previous_request_ids` carries up to 3 prior request IDs. The model
 *     conditions on the *actual audio* of those generations, which is the
 *     mechanism that keeps prosody coherent across chunk boundaries.
 *   - `previous_text` / `next_text` add textual context. Always cheap to set.
 *   - The first chunk has no prior; the last chunk has no next. That's fine.
 *
 * PCM vs MP3 path:
 *   - Default output format is `pcm_44100` (raw 16-bit mono LE). Chunks are
 *     concatenated by byte-concatenation (lossless, exact) and then wrapped
 *     in a WAV header before ffmpeg picks them up for loudnorm.
 *   - If callers ask for an mp3 format we save each chunk to disk and run
 *     `ffmpeg -f concat -c copy` — also lossless, just slower to set up.
 */

import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  synthesizeChunk,
  wrapPcmAsWav,
  sampleRateFromFormat,
  DEFAULT_MODEL,
  DEFAULT_VOICE_ID,
  type AudioFormat,
  type ElevenLabsModel,
  type VoiceSettings,
} from "./client.js";
import { chunkForStitching } from "./chunker.js";
import {
  finalizeAudio,
  concatAudioFiles,
  probeDuration,
  type LoudnessOptions,
} from "./postprocess.js";

export interface ElevenLabsSynthesizeOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: ElevenLabsModel;
  /** Wire format for the API requests. Default `pcm_44100` for lossless concat. */
  outputFormat?: AudioFormat;
  voiceSettings?: VoiceSettings;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";

  /**
   * Stitching mode. `request-id` (default) is the highest quality — chunks
   * condition on the audio of prior chunks. `text` is cheaper but only
   * carries textual context. `off` disables stitching entirely (single
   * isolated requests).
   */
  stitch?: "request-id" | "text" | "off";

  chunkOptions?: { targetChars?: number; maxChars?: number };

  /** Loudness normalization config or `false` to skip. */
  loudness?: LoudnessOptions | false;

  /** Final sample rate after loudnorm. 48 kHz is the engine's native rate. */
  sampleRate?: number;
  /** Final channel count. The mixer expects stereo. */
  channels?: 1 | 2;

  /** Override the API base for tests. */
  apiBase?: string;
  /** Cancel mid-flight. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ElevenLabsSynthesizeResult {
  outputPath: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  chunksGenerated: number;
  totalCharacters: number;
  modelId: string;
  voiceId: string;
  loudnessApplied: boolean;
  /** Request IDs in generation order — useful for debugging or replays. */
  requestIds: string[];
}

const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> = {
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

export async function synthesize(
  text: string,
  outputPath: string,
  options: ElevenLabsSynthesizeOptions,
): Promise<ElevenLabsSynthesizeResult> {
  if (!options.apiKey) {
    throw new Error("ElevenLabs API key required. Set ELEVENLABS_API_KEY or pass --api-key.");
  }

  const cleaned = text.trim();
  if (!cleaned) throw new Error("No text to synthesize");

  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const modelId = options.modelId ?? DEFAULT_MODEL;
  const outputFormat: AudioFormat = options.outputFormat ?? "pcm_44100";
  const stitch = options.stitch ?? "request-id";
  const voiceSettings: VoiceSettings = {
    ...DEFAULT_VOICE_SETTINGS,
    ...options.voiceSettings,
  };

  const chunks = chunkForStitching(cleaned, options.chunkOptions);
  if (chunks.length === 0) throw new Error("Chunking produced no output");

  const isPcm = outputFormat.startsWith("pcm_");
  const sourceRate = sampleRateFromFormat(outputFormat);

  mkdirSync(dirname(outputPath), { recursive: true });

  // Sequential — request_ids must reference completed prior requests.
  const requestIds: string[] = [];
  const pcmBuffers: Buffer[] = [];
  const mp3ChunkPaths: string[] = [];
  let totalChars = 0;

  const sessionId = `${process.pid}-${Date.now()}`;
  const chunkDir = join(tmpdir(), `hf-elevenlabs-${sessionId}`);
  if (!isPcm) mkdirSync(chunkDir, { recursive: true });

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      totalChars += chunk.length;
      options.onProgress?.(`Generating chunk ${i + 1}/${chunks.length} (${chunk.length} chars)...`);

      const previousRequestIds = stitch === "request-id" ? requestIds.slice(-3) : undefined;
      const previousText = stitch !== "off" && i > 0 ? chunks[i - 1] : undefined;
      const nextText = stitch !== "off" && i < chunks.length - 1 ? chunks[i + 1] : undefined;

      const { audio, requestId } = await synthesizeChunk({
        voiceId,
        text: chunk,
        modelId,
        outputFormat,
        voiceSettings,
        previousRequestIds,
        previousText,
        nextText,
        seed: options.seed,
        applyTextNormalization: options.applyTextNormalization,
        apiKey: options.apiKey,
        apiBase: options.apiBase,
        signal: options.signal,
      });

      if (requestId) requestIds.push(requestId);

      if (isPcm) {
        pcmBuffers.push(audio);
      } else {
        const path = join(chunkDir, `chunk-${String(i).padStart(4, "0")}.mp3`);
        writeFileSync(path, audio);
        mp3ChunkPaths.push(path);
      }
    }

    // ── Assemble single source file before ffmpeg finalize ──────────────
    const intermediatePath = join(chunkDir, `joined-${sessionId}.${isPcm ? "wav" : "mp3"}`);
    mkdirSync(dirname(intermediatePath), { recursive: true });

    if (isPcm) {
      const merged = Buffer.concat(pcmBuffers);
      const wav = wrapPcmAsWav(merged, sourceRate, 1);
      writeFileSync(intermediatePath, wav);
    } else {
      await concatAudioFiles(mp3ChunkPaths, intermediatePath);
    }

    // ── Finalize: loudnorm + resample + stereo ──────────────────────────
    const { sampleRate, channels, loudnessApplied } = await finalizeAudio(
      intermediatePath,
      outputPath,
      {
        loudness: options.loudness,
        sampleRate: options.sampleRate,
        channels: options.channels,
        onProgress: options.onProgress,
      },
    );

    const durationSeconds = await probeDuration(outputPath);

    return {
      outputPath,
      durationSeconds: Math.round(durationSeconds * 1000) / 1000,
      sampleRate,
      channels,
      chunksGenerated: chunks.length,
      totalCharacters: totalChars,
      modelId,
      voiceId,
      loudnessApplied,
      requestIds,
    };
  } finally {
    // Cleanup temp chunks.
    if (!isPcm) {
      for (const p of mp3ChunkPaths) {
        try {
          unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
    try {
      const { rmSync } = await import("node:fs");
      if (existsSync(chunkDir)) rmSync(chunkDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

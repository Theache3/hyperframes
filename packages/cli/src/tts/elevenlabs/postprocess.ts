/**
 * Post-processing steps applied after all chunks have been generated and
 * concatenated. The render pipeline ([audioMixer.ts]) does not loudness-
 * normalize, so doing it here is what keeps the VO sitting at a predictable
 * level relative to music and SFX in the final mix.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { findFFmpeg } from "../../browser/ffmpeg.js";

const execFileAsync = promisify(execFile);

export interface LoudnessOptions {
  /** Integrated loudness target in LUFS. -16 is the standard for online video. */
  integrated?: number;
  /** True-peak ceiling in dBTP. -1.5 leaves headroom for codec losses. */
  truePeak?: number;
  /** Loudness range target. 11 is a reasonable default for narration. */
  range?: number;
}

export interface FinalizeOptions {
  /** Apply EBU R128 loudness normalization. Defaults to true. */
  loudness?: LoudnessOptions | false;
  /**
   * Output sample rate. The HyperFrames mixer extracts everything to 48 kHz
   * stereo before mixing, so producing 48k here avoids a redundant resample
   * inside the engine.
   */
  sampleRate?: number;
  /** Output channels: 1=mono, 2=stereo. Stereo is what the engine expects. */
  channels?: 1 | 2;
  /** Forward progress messages to the CLI spinner. */
  onProgress?: (message: string) => void;
}

const DEFAULT_LOUDNESS: Required<LoudnessOptions> = {
  integrated: -16,
  truePeak: -1.5,
  range: 11,
};

/**
 * Run an arbitrary WAV (or any FFmpeg-readable input) through a finalize
 * pass: optional loudnorm, resample to the engine's native rate, and force
 * stereo. Overwrites the destination atomically (.tmp + rename).
 */
export async function finalizeAudio(
  inputPath: string,
  outputPath: string,
  options: FinalizeOptions = {},
): Promise<{ sampleRate: number; channels: number; loudnessApplied: boolean }> {
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg is required for ElevenLabs post-processing (loudness + resample). Install it and re-run.",
    );
  }

  const sampleRate = options.sampleRate ?? 48000;
  const channels: 1 | 2 = options.channels ?? 2;
  const loudnessApplied = options.loudness !== false;

  const filters: string[] = [];
  if (loudnessApplied) {
    const l: Required<LoudnessOptions> = {
      ...DEFAULT_LOUDNESS,
      ...(typeof options.loudness === "object" ? options.loudness : {}),
    };
    filters.push(`loudnorm=I=${l.integrated}:TP=${l.truePeak}:LRA=${l.range}`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp.wav`;

  options.onProgress?.(
    loudnessApplied
      ? `Normalizing loudness (target ${DEFAULT_LOUDNESS.integrated} LUFS)...`
      : "Resampling audio...",
  );

  const args = [
    "-y",
    "-i",
    inputPath,
    ...(filters.length > 0 ? ["-af", filters.join(",")] : []),
    "-ar",
    String(sampleRate),
    "-ac",
    String(channels),
    "-c:a",
    "pcm_s16le",
    tmp,
  ];

  try {
    await execFileAsync(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
    if (!existsSync(tmp)) {
      throw new Error("ffmpeg ran but produced no output");
    }
    // Atomic-ish replace.
    if (existsSync(outputPath)) {
      try {
        unlinkSync(outputPath);
      } catch {
        // ignore — rename will overwrite on most platforms
      }
    }
    const { renameSync } = await import("node:fs");
    renameSync(tmp, outputPath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg post-processing failed: ${detail.slice(0, 500)}`);
  }

  return { sampleRate, channels, loudnessApplied };
}

/**
 * Concatenate a list of input audio files (any FFmpeg-readable format) into
 * one. Used when chunks come back as MP3 — for raw PCM, callers should just
 * `Buffer.concat` the chunks directly, which is cheaper and lossless.
 */
export async function concatAudioFiles(inputs: string[], outputPath: string): Promise<void> {
  if (inputs.length === 0) throw new Error("concatAudioFiles: no inputs");
  if (inputs.length === 1) {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(inputs[0]!, outputPath);
    return;
  }
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is required to concatenate chunks");

  const { tmpdir } = await import("node:os");
  const listPath = join(tmpdir(), `hf-eleven-concat-${process.pid}-${Date.now()}.txt`);
  const lines = inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(listPath, lines, "utf-8");

  try {
    await execFileAsync(
      ffmpeg,
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    try {
      unlinkSync(listPath);
    } catch {
      // ignore — best-effort
    }
  }
}

/**
 * Probe a file's duration in seconds using ffprobe (falls back to a quick
 * ffmpeg pass if ffprobe isn't available).
 */
export async function probeDuration(path: string): Promise<number> {
  // Prefer ffprobe.
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    const n = parseFloat(stdout.trim());
    if (Number.isFinite(n)) return n;
  } catch {
    // fall through
  }
  // Fallback: ffmpeg -i path -f null - and parse stderr.
  const ffmpeg = findFFmpeg();
  if (!ffmpeg) return 0;
  try {
    await execFileAsync(ffmpeg, ["-i", path, "-f", "null", "-"]);
  } catch (err) {
    // ffmpeg writes "Duration: HH:MM:SS.ms" to stderr; exit code is non-zero
    // when no output is requested, so we catch and parse here.
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) {
      const [h, mn, s] = [m[1], m[2], m[3]];
      return parseInt(h ?? "0", 10) * 3600 + parseInt(mn ?? "0", 10) * 60 + parseFloat(s ?? "0");
    }
  }
  return 0;
}

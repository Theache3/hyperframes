import { defineCommand } from "citty";
import type { Example } from "./_examples.js";
import { existsSync, readFileSync } from "node:fs";

export const examples: Example[] = [
  ["Generate speech from text (local Kokoro)", 'hyperframes tts "Welcome to HyperFrames"'],
  ["Choose a Kokoro voice", 'hyperframes tts "Hello world" --voice am_adam'],
  ["Save to a specific file", 'hyperframes tts "Intro" --voice bf_emma --output narration.wav'],
  ["Adjust speech speed", 'hyperframes tts "Slow and clear" --speed 0.8'],
  [
    "Generate Spanish speech (Kokoro)",
    'hyperframes tts "La reunión empieza a las nueve" --voice ef_dora --output es.wav',
  ],
  [
    "Override phonemizer language",
    'hyperframes tts "Ciao a tutti" --voice af_heart --lang it --output accented.wav',
  ],
  ["Read text from a file", "hyperframes tts script.txt"],
  ["List available Kokoro voices", "hyperframes tts --list"],
  [
    "Generate with ElevenLabs (request stitching + loudness normalization)",
    "hyperframes tts script.txt --provider elevenlabs --voice 21m00Tcm4TlvDq8ikWAM --output narration.wav",
  ],
  [
    "ElevenLabs with fixed seed for reproducibility",
    "hyperframes tts script.txt --provider elevenlabs --voice <id> --seed 12345",
  ],
  ["List ElevenLabs voices for your account", "hyperframes tts --list --provider elevenlabs"],
];
import { resolve, extname } from "node:path";
import * as clack from "@clack/prompts";
import { c } from "../ui/colors.js";
import { errorBox } from "../ui/format.js";
import {
  DEFAULT_VOICE,
  BUNDLED_VOICES,
  SUPPORTED_LANGS,
  inferLangFromVoiceId,
  isSupportedLang,
  type SupportedLang,
} from "../tts/manager.js";
import {
  DEFAULT_MODEL as ELEVENLABS_DEFAULT_MODEL,
  DEFAULT_VOICE_ID as ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_MODELS,
  type ElevenLabsModel,
} from "../tts/elevenlabs/client.js";

const voiceList = BUNDLED_VOICES.map((v) => `${v.id} (${v.label})`).join(", ");
const langList = SUPPORTED_LANGS.join(", ");
const elevenlabsModelList = ELEVENLABS_MODELS.join(", ");

type Provider = "kokoro" | "elevenlabs";

function isProvider(value: string): value is Provider {
  return value === "kokoro" || value === "elevenlabs";
}

function isElevenLabsModel(value: string): value is ElevenLabsModel {
  return (ELEVENLABS_MODELS as readonly string[]).includes(value);
}

function parseFloatArg(name: string, raw: unknown, min: number, max: number): number {
  const n = parseFloat(String(raw));
  if (Number.isNaN(n) || n < min || n > max) {
    errorBox(`Invalid --${name}`, `Got "${raw}". Must be a number between ${min} and ${max}.`);
    process.exit(1);
  }
  return n;
}

export default defineCommand({
  meta: {
    name: "tts",
    description:
      "Generate speech audio from text. Local AI (Kokoro-82M) by default, or ElevenLabs cloud with --provider elevenlabs.",
  },
  args: {
    input: {
      type: "positional",
      description: "Text to speak, or path to a .txt file",
      required: false,
    },
    output: {
      type: "string",
      description: "Output file path (default: speech.wav in current directory)",
      alias: "o",
    },
    provider: {
      type: "string",
      description: "Speech provider: kokoro (local, default) or elevenlabs (cloud)",
      alias: "p",
    },
    voice: {
      type: "string",
      description: `Voice ID. Kokoro options: ${voiceList}. ElevenLabs: any voice_id from your account (default: Rachel).`,
      alias: "v",
    },
    speed: {
      type: "string",
      description: "Speech speed multiplier (Kokoro only, default: 1.0)",
      alias: "s",
    },
    lang: {
      type: "string",
      description: `Phonemizer language for Kokoro (auto-detected from voice prefix). Options: ${langList}`,
      alias: "l",
    },
    list: {
      type: "boolean",
      description:
        "List available voices and exit. With --provider elevenlabs, calls the API to list account voices.",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output result as JSON",
      default: false,
    },
    // ── ElevenLabs-specific ────────────────────────────────────────────
    "api-key": {
      type: "string",
      description: "ElevenLabs API key (default: $ELEVENLABS_API_KEY env var)",
    },
    model: {
      type: "string",
      description: `ElevenLabs model_id (default: ${ELEVENLABS_DEFAULT_MODEL}). Options: ${elevenlabsModelList}`,
    },
    stability: {
      type: "string",
      description: "ElevenLabs voice_settings.stability 0-1 (default: 0.45)",
    },
    similarity: {
      type: "string",
      description: "ElevenLabs voice_settings.similarity_boost 0-1 (default: 0.75)",
    },
    style: {
      type: "string",
      description: "ElevenLabs voice_settings.style 0-1 (default: 0)",
    },
    "no-speaker-boost": {
      type: "boolean",
      description: "Disable ElevenLabs use_speaker_boost (default: enabled)",
      default: false,
    },
    seed: {
      type: "string",
      description: "ElevenLabs seed for reproducibility. Same seed + text + settings = same audio.",
    },
    stitch: {
      type: "string",
      description: "ElevenLabs stitching mode: request-id (default, highest quality), text, or off",
    },
    "chunk-chars": {
      type: "string",
      description: "Target characters per ElevenLabs request chunk (default: 350)",
    },
    "no-normalize": {
      type: "boolean",
      description:
        "Skip ElevenLabs's apply_text_normalization (default: 'off' — already pre-normalized)",
      default: false,
    },
    loudness: {
      type: "string",
      description:
        "Target integrated loudness in LUFS (default: -16). Pass 'off' to skip normalization.",
    },
    "sample-rate": {
      type: "string",
      description: "Final WAV sample rate in Hz (default: 48000 — matches the render mixer)",
    },
    mono: {
      type: "boolean",
      description: "Emit mono WAV instead of stereo (default: stereo)",
      default: false,
    },
  },
  async run({ args }) {
    // ── Resolve provider ──────────────────────────────────────────────
    const providerRaw = String(args.provider ?? "kokoro").toLowerCase();
    if (!isProvider(providerRaw)) {
      errorBox("Invalid --provider", `Got "${args.provider}". Must be kokoro or elevenlabs.`);
      process.exit(1);
    }
    const provider: Provider = providerRaw;

    // ── List voices mode ──────────────────────────────────────────────
    if (args.list) {
      if (provider === "elevenlabs") {
        return listElevenLabsVoices(args);
      }
      return listKokoroVoices(args.json);
    }

    // ── Resolve input text ────────────────────────────────────────────
    if (!args.input) {
      console.error(c.error("Provide text to speak, or use --list to see available voices."));
      process.exit(1);
    }

    let text: string;
    const maybeFile = resolve(args.input);

    if (existsSync(maybeFile) && extname(maybeFile).toLowerCase() === ".txt") {
      text = readFileSync(maybeFile, "utf-8").trim();
      if (!text) {
        console.error(c.error("File is empty."));
        process.exit(1);
      }
    } else {
      text = args.input;
    }

    if (!text.trim()) {
      console.error(c.error("No text provided."));
      process.exit(1);
    }

    // ── Resolve output path ───────────────────────────────────────────
    const output = resolve(args.output ?? "speech.wav");

    if (provider === "elevenlabs") {
      return runElevenLabs({ args, text, output });
    }
    return runKokoro({ args, text, output });
  },
});

// ---------------------------------------------------------------------------
// Kokoro path (unchanged behavior)
// ---------------------------------------------------------------------------

async function runKokoro(ctx: {
  args: Record<string, unknown>;
  text: string;
  output: string;
}): Promise<void> {
  const { args, text, output } = ctx;

  const voice = (args["voice"] as string | undefined) ?? DEFAULT_VOICE;
  const speed = args["speed"] ? parseFloat(String(args["speed"])) : 1.0;
  const jsonOut = Boolean(args["json"]);

  if (isNaN(speed) || speed <= 0 || speed > 3) {
    console.error(c.error("Speed must be a number between 0.1 and 3.0"));
    process.exit(1);
  }

  const inferredLang = inferLangFromVoiceId(voice);
  let lang: SupportedLang = inferredLang;
  if (args["lang"] != null) {
    const requested = String(args["lang"]).toLowerCase();
    if (!isSupportedLang(requested)) {
      errorBox("Invalid --lang", `Got "${args["lang"]}". Must be one of: ${langList}.`);
      process.exit(1);
    }
    lang = requested;
  }

  if (!jsonOut && args["lang"] != null && lang !== inferredLang) {
    console.log(
      c.dim(`  Note: voice "${voice}" is ${inferredLang}, rendering with --lang ${lang} instead.`),
    );
  }

  const { synthesize } = await import("../tts/synthesize.js");
  const spin = jsonOut ? null : clack.spinner();
  spin?.start(`Generating speech with ${c.accent(voice)} (${lang})...`);

  try {
    const result = await synthesize(text, output, {
      voice,
      speed,
      lang,
      onProgress: spin ? (msg) => spin.message(msg) : undefined,
    });

    if (jsonOut) {
      console.log(
        JSON.stringify({
          ok: true,
          provider: "kokoro",
          voice,
          speed,
          lang,
          langApplied: result.langApplied,
          durationSeconds: result.durationSeconds,
          outputPath: result.outputPath,
        }),
      );
    } else {
      spin?.stop(
        c.success(
          `Generated ${c.accent(result.durationSeconds.toFixed(1) + "s")} of speech → ${c.accent(result.outputPath)}`,
        ),
      );
      if (args["lang"] != null && !result.langApplied) {
        console.log(
          c.dim(
            "  Note: installed kokoro-onnx version does not support the --lang kwarg; phonemization used Kokoro's default.",
          ),
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonOut) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      spin?.stop(c.error(`Speech synthesis failed: ${message}`));
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs path
// ---------------------------------------------------------------------------

async function runElevenLabs(ctx: {
  args: Record<string, unknown>;
  text: string;
  output: string;
}): Promise<void> {
  const { args, text, output } = ctx;
  const jsonOut = Boolean(args["json"]);

  const apiKey = (args["api-key"] as string | undefined) ?? process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    errorBox(
      "Missing ElevenLabs API key",
      "Set ELEVENLABS_API_KEY in your environment, or pass --api-key <key>.",
      "Get one from https://elevenlabs.io/app/settings/api-keys",
    );
    process.exit(1);
  }

  const voiceId = (args["voice"] as string | undefined) ?? ELEVENLABS_DEFAULT_VOICE;

  const modelRaw = (args["model"] as string | undefined) ?? ELEVENLABS_DEFAULT_MODEL;
  if (!isElevenLabsModel(modelRaw)) {
    errorBox("Invalid --model", `Got "${modelRaw}". Must be one of: ${elevenlabsModelList}.`);
    process.exit(1);
  }
  const modelId: ElevenLabsModel = modelRaw;

  const stitchRaw = ((args["stitch"] as string | undefined) ?? "request-id").toLowerCase();
  if (stitchRaw !== "request-id" && stitchRaw !== "text" && stitchRaw !== "off") {
    errorBox("Invalid --stitch", `Got "${args["stitch"]}". Must be request-id, text, or off.`);
    process.exit(1);
  }

  const voiceSettings = {
    stability:
      args["stability"] != null ? parseFloatArg("stability", args["stability"], 0, 1) : 0.45,
    similarity_boost:
      args["similarity"] != null ? parseFloatArg("similarity", args["similarity"], 0, 1) : 0.75,
    style: args["style"] != null ? parseFloatArg("style", args["style"], 0, 1) : 0,
    use_speaker_boost: !args["no-speaker-boost"],
  };

  const seedRaw = args["seed"];
  const seed = seedRaw != null ? Number.parseInt(String(seedRaw), 10) : undefined;
  if (seedRaw != null && (seed === undefined || Number.isNaN(seed))) {
    errorBox("Invalid --seed", `Got "${seedRaw}". Must be an integer.`);
    process.exit(1);
  }

  const chunkChars =
    args["chunk-chars"] != null
      ? parseFloatArg("chunk-chars", args["chunk-chars"], 50, 4000)
      : undefined;

  const sampleRate =
    args["sample-rate"] != null
      ? parseFloatArg("sample-rate", args["sample-rate"], 8000, 96000)
      : 48000;

  // Loudness: number (LUFS target) or 'off' to skip.
  let loudness: { integrated: number } | false = { integrated: -16 };
  if (args["loudness"] != null) {
    const raw = String(args["loudness"]).toLowerCase();
    if (raw === "off" || raw === "none" || raw === "false") {
      loudness = false;
    } else {
      const n = parseFloat(raw);
      if (Number.isNaN(n) || n > 0 || n < -70) {
        errorBox(
          "Invalid --loudness",
          `Got "${args["loudness"]}". Must be a negative number in LUFS (e.g. -16, -14) or 'off'.`,
        );
        process.exit(1);
      }
      loudness = { integrated: n };
    }
  }

  const channels: 1 | 2 = args["mono"] ? 1 : 2;

  const { synthesize } = await import("../tts/elevenlabs/synthesize.js");
  const spin = jsonOut ? null : clack.spinner();
  spin?.start(`Generating speech with ElevenLabs voice ${c.accent(voiceId)} (${modelId})...`);

  try {
    const result = await synthesize(text, output, {
      apiKey,
      voiceId,
      modelId,
      voiceSettings,
      seed,
      stitch: stitchRaw as "request-id" | "text" | "off",
      chunkOptions: chunkChars != null ? { targetChars: chunkChars } : undefined,
      loudness,
      sampleRate,
      channels,
      applyTextNormalization: args["no-normalize"] ? undefined : "off",
      onProgress: spin ? (msg) => spin.message(msg) : undefined,
    });

    if (jsonOut) {
      console.log(
        JSON.stringify({
          ok: true,
          provider: "elevenlabs",
          voiceId: result.voiceId,
          modelId: result.modelId,
          durationSeconds: result.durationSeconds,
          sampleRate: result.sampleRate,
          channels: result.channels,
          chunksGenerated: result.chunksGenerated,
          totalCharacters: result.totalCharacters,
          loudnessApplied: result.loudnessApplied,
          requestIds: result.requestIds,
          outputPath: result.outputPath,
        }),
      );
    } else {
      spin?.stop(
        c.success(
          `Generated ${c.accent(result.durationSeconds.toFixed(1) + "s")} of speech across ${result.chunksGenerated} chunk(s) → ${c.accent(result.outputPath)}`,
        ),
      );
      console.log(
        c.dim(
          `  ${result.sampleRate / 1000} kHz ${result.channels === 2 ? "stereo" : "mono"} · ${result.totalCharacters} chars · ${result.loudnessApplied ? "loudness-normalized" : "raw level"}`,
        ),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonOut) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      spin?.stop(c.error(`ElevenLabs synthesis failed: ${message}`));
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// List voices
// ---------------------------------------------------------------------------

function listKokoroVoices(json: boolean): void {
  const rows = BUNDLED_VOICES.map((v) => ({ ...v, defaultLang: inferLangFromVoiceId(v.id) }));

  if (json) {
    console.log(JSON.stringify(rows));
    return;
  }

  console.log(`\n${c.bold("Available voices")} (Kokoro-82M)\n`);
  console.log(
    `  ${c.dim("ID")}                ${c.dim("Name")}         ${c.dim("Language")}   ${c.dim("Lang code")}  ${c.dim("Gender")}`,
  );
  console.log(`  ${c.dim("─".repeat(72))}`);
  for (const row of rows) {
    const id = row.id.padEnd(18);
    const label = row.label.padEnd(13);
    const lang = row.language.padEnd(10);
    const code = row.defaultLang.padEnd(10);
    console.log(`  ${c.accent(id)} ${label} ${lang} ${code} ${row.gender}`);
  }
  console.log(
    `\n  ${c.dim("Use any Kokoro voice ID — see https://github.com/thewh1teagle/kokoro-onnx for all 54 voices")}`,
  );
  console.log(
    `  ${c.dim("Override phonemizer with --lang <" + SUPPORTED_LANGS.join("|") + ">")}\n`,
  );
}

async function listElevenLabsVoices(args: Record<string, unknown>): Promise<void> {
  const json = Boolean(args["json"]);
  const apiKey = (args["api-key"] as string | undefined) ?? process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    errorBox(
      "Missing ElevenLabs API key",
      "Set ELEVENLABS_API_KEY or pass --api-key <key> to list account voices.",
    );
    process.exit(1);
  }

  const { listVoices } = await import("../tts/elevenlabs/client.js");

  try {
    const voices = await listVoices({ apiKey });
    if (json) {
      console.log(JSON.stringify(voices));
      return;
    }

    console.log(`\n${c.bold("ElevenLabs voices")} (${voices.length})\n`);
    console.log(
      `  ${c.dim("voice_id".padEnd(24))} ${c.dim("Name".padEnd(20))} ${c.dim("Category")}`,
    );
    console.log(`  ${c.dim("─".repeat(72))}`);
    for (const v of voices) {
      const id = v.voice_id.padEnd(24);
      const name = (v.name ?? "").padEnd(20);
      const cat = v.category ?? "";
      console.log(`  ${c.accent(id)} ${name} ${c.dim(cat)}`);
    }
    console.log(`\n  ${c.dim("Pass any voice_id via --voice <id>")}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      errorBox("Failed to list ElevenLabs voices", message);
    }
    process.exit(1);
  }
}

import { afterEach, describe, expect, it } from "vitest";
import {
  ElevenLabsApiError,
  sampleRateFromFormat,
  synthesizeChunk,
  wrapPcmAsWav,
} from "./client.js";

describe("wrapPcmAsWav", () => {
  it("produces a 44-byte RIFF header + body", () => {
    const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
    const wav = wrapPcmAsWav(pcm, 44100, 1);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(44100); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it("encodes the correct byte rate / block align for stereo", () => {
    const pcm = Buffer.alloc(8);
    const wav = wrapPcmAsWav(pcm, 48000, 2);
    expect(wav.readUInt32LE(28)).toBe((48000 * 2 * 16) / 8);
    expect(wav.readUInt16LE(32)).toBe((2 * 16) / 8);
  });
});

describe("sampleRateFromFormat", () => {
  it.each([
    ["pcm_44100", 44100],
    ["pcm_24000", 24000],
    ["pcm_22050", 22050],
    ["pcm_16000", 16000],
    ["mp3_44100_192", 44100],
    ["mp3_44100_128", 44100],
  ] as const)("parses %s → %d", (format, expected) => {
    expect(sampleRateFromFormat(format)).toBe(expected);
  });
});

describe("synthesizeChunk", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to /v1/text-to-speech/{voice}, returns audio + request-id", async () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    const captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(audio, {
        status: 200,
        headers: { "request-id": "req-abc-123" },
      });
    }) as typeof fetch;

    const result = await synthesizeChunk({
      apiKey: "test-key",
      voiceId: "voice-xyz",
      text: "Hello world.",
      modelId: "eleven_multilingual_v2",
      outputFormat: "pcm_44100",
      voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
      apiBase: "https://example.test",
    });

    expect(result.audio).toEqual(audio);
    expect(result.requestId).toBe("req-abc-123");
    expect(captured.url).toBe(
      "https://example.test/v1/text-to-speech/voice-xyz?output_format=pcm_44100",
    );
    const headers = new Headers(captured.init?.headers as HeadersInit);
    expect(headers.get("xi-api-key")).toBe("test-key");
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
    expect(body["text"]).toBe("Hello world.");
    expect(body["model_id"]).toBe("eleven_multilingual_v2");
    expect(body["voice_settings"]).toEqual({ stability: 0.5, similarity_boost: 0.75 });
    expect(body["previous_request_ids"]).toBeUndefined();
  });

  it("forwards previous_request_ids (capped at 3) + text + next_text + seed", async () => {
    const captured: { body?: string } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured.body = String(init.body);
      return new Response(Buffer.from([0]), { status: 200, headers: {} });
    }) as typeof fetch;

    await synthesizeChunk({
      apiKey: "k",
      voiceId: "v",
      text: "Third chunk.",
      modelId: "eleven_multilingual_v2",
      outputFormat: "pcm_44100",
      voiceSettings: {},
      previousRequestIds: ["a", "b", "c", "d", "e"],
      previousText: "Second chunk.",
      nextText: "Fourth chunk.",
      seed: 42,
      applyTextNormalization: "off",
    });

    const body = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
    expect(body["previous_request_ids"]).toEqual(["c", "d", "e"]);
    expect(body["previous_text"]).toBe("Second chunk.");
    expect(body["next_text"]).toBe("Fourth chunk.");
    expect(body["seed"]).toBe(42);
    expect(body["apply_text_normalization"]).toBe("off");
  });

  it("throws ElevenLabsApiError on non-2xx with body excerpt", async () => {
    globalThis.fetch = (async () => {
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;

    await expect(
      synthesizeChunk({
        apiKey: "k",
        voiceId: "v",
        text: "hi",
        modelId: "eleven_multilingual_v2",
        outputFormat: "pcm_44100",
        voiceSettings: {},
      }),
    ).rejects.toMatchObject({
      name: "ElevenLabsApiError",
      status: 429,
      body: "rate limited",
    });
  });

  it("ElevenLabsApiError carries status + body", () => {
    const e = new ElevenLabsApiError("boom", 500, "internal");
    expect(e.status).toBe(500);
    expect(e.body).toBe("internal");
  });
});

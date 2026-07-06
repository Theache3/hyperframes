/**
 * Split narration text into chunks suitable for ElevenLabs request stitching.
 *
 * Why chunk at all: ElevenLabs has a single-request character limit (5000 for
 * most models), and even below that limit, generating very long passages in
 * one call produces noticeably worse prosody than several short calls that
 * carry context via `previous_request_ids`. Chunks of ~250-500 chars hit the
 * sweet spot.
 *
 * Rules:
 * 1. Cut on sentence boundaries (`. ! ?` followed by whitespace). Never split
 *    mid-sentence except for the runaway-sentence safety net below.
 * 2. Greedily pack sentences into a chunk until adding the next would exceed
 *    `targetChars`. The previous chunk is finalized at that point.
 * 3. If a single sentence is longer than `maxChars`, fall back to splitting on
 *    clause boundaries (`; , — :`) so we still get something stitchable. This
 *    is rare — only triggers on pathological input.
 * 4. Preserve trailing punctuation and whitespace as-is — ElevenLabs uses it
 *    for prosody.
 */

export interface ChunkOptions {
  /** Soft upper bound — chunker stops packing once the next sentence would exceed this. */
  targetChars?: number;
  /** Hard ceiling for a single chunk; sentences longer than this get clause-split. */
  maxChars?: number;
}

const DEFAULT_TARGET = 350;
const DEFAULT_MAX = 800;

// Common abbreviations that end in `.` but do not end a sentence. Lowercased.
// Kept short on purpose — being too aggressive here masks real sentence ends.
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "ie",
  "eg",
  "no",
  "vol",
  "inc",
  "ltd",
  "co",
  "corp",
]);

/**
 * Split text into sentences. Conservative — prefers leaving punctuation
 * uncertain rather than splitting in the middle of "Dr. Smith".
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] ?? "";
    current += ch;

    if (ch === "." || ch === "!" || ch === "?") {
      // Consume any trailing close-punctuation (quotes, brackets).
      while (i + 1 < trimmed.length && /["')\]”’]/.test(trimmed[i + 1] ?? "")) {
        i++;
        current += trimmed[i];
      }

      const next = trimmed[i + 1];
      const endOfText = i + 1 >= trimmed.length;
      const followedByWhitespace = next !== undefined && /\s/.test(next);

      if (!endOfText && !followedByWhitespace) continue;

      // Skip if preceded by a known abbreviation.
      if (ch === "." && isLikelyAbbreviation(current)) continue;

      // Skip if the next non-space char is lowercase (rare but real:
      // "version 1.5 is out" — the "." inside "1.5" already failed the
      // whitespace check, but defensive).
      if (!endOfText) {
        const rest = trimmed.slice(i + 1).trimStart();
        const firstRest = rest.charAt(0);
        if (firstRest && firstRest === firstRest.toLowerCase() && /[a-z]/.test(firstRest)) {
          continue;
        }
      }

      sentences.push(current.trim());
      current = "";

      // Consume the whitespace separator so it doesn't get attributed to the
      // next sentence as a leading space.
      while (i + 1 < trimmed.length && /\s/.test(trimmed[i + 1] ?? "")) i++;
    }
  }

  const tail = current.trim();
  if (tail) sentences.push(tail);

  return sentences;
}

function isLikelyAbbreviation(soFar: string): boolean {
  const match = soFar.match(/(\S+)\.$/);
  if (!match) return false;
  const word = (match[1] ?? "").toLowerCase().replace(/[^a-z.]/g, "");
  return ABBREVIATIONS.has(word);
}

/**
 * Hard-split a runaway sentence on clause boundaries so it fits under maxChars.
 * Only invoked when a single sentence is longer than `maxChars`.
 */
function splitClauses(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];

  // Try `; ` first (strongest non-terminal boundary), then `, `, then ` — `.
  for (const sep of ["; ", ", ", " — ", " – ", ": "]) {
    if (!sentence.includes(sep)) continue;
    const parts = sentence.split(sep);
    const out: string[] = [];
    let cur = "";
    for (const part of parts) {
      const candidate = cur ? `${cur}${sep}${part}` : part;
      if (candidate.length > maxChars && cur) {
        out.push(cur);
        cur = part;
      } else {
        cur = candidate;
      }
    }
    if (cur) out.push(cur);
    if (out.every((p) => p.length <= maxChars)) return out;
  }

  // Last resort: hard-cut at maxChars on the nearest word boundary.
  const out: string[] = [];
  let remaining = sentence;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

/**
 * Group sentences into chunks for ElevenLabs. Each chunk stays under
 * `targetChars` when possible, falls back to `maxChars` for runaway sentences.
 *
 * Empty/whitespace input returns an empty array — never throws.
 */
export function chunkForStitching(text: string, options: ChunkOptions = {}): string[] {
  const target = options.targetChars ?? DEFAULT_TARGET;
  const max = options.maxChars ?? DEFAULT_MAX;

  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  // Pre-expand any sentence that overshoots max into clause-sized pieces.
  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length > max) {
      pieces.push(...splitClauses(s, max));
    } else {
      pieces.push(s);
    }
  }

  const chunks: string[] = [];
  let buffer = "";

  for (const piece of pieces) {
    if (!buffer) {
      buffer = piece;
      continue;
    }
    const merged = `${buffer} ${piece}`;
    if (merged.length > target) {
      chunks.push(buffer);
      buffer = piece;
    } else {
      buffer = merged;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

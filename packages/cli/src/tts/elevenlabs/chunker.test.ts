import { describe, expect, it } from "vitest";
import { chunkForStitching, splitSentences } from "./chunker.js";

describe("splitSentences", () => {
  it("splits on period + space + capital", () => {
    expect(splitSentences("Hello world. How are you?")).toEqual(["Hello world.", "How are you?"]);
  });

  it("keeps trailing close-quotes attached to the sentence they end", () => {
    expect(splitSentences('She said "go." Then he left.')).toEqual([
      'She said "go."',
      "Then he left.",
    ]);
  });

  it("does not split on common abbreviations", () => {
    const out = splitSentences("Dr. Smith arrived. Then she spoke.");
    expect(out).toEqual(["Dr. Smith arrived.", "Then she spoke."]);
  });

  it("does not split when the next char is lowercase", () => {
    // Edge case the regex defends against — should not split mid-thought.
    expect(splitSentences("version 1.5 is out today.")).toEqual(["version 1.5 is out today."]);
  });

  it("returns the whole input when there's no terminal punctuation", () => {
    expect(splitSentences("just a fragment with no period")).toEqual([
      "just a fragment with no period",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });

  it("handles exclamation and question marks", () => {
    expect(splitSentences("Wow! Really? Yes.")).toEqual(["Wow!", "Really?", "Yes."]);
  });
});

describe("chunkForStitching", () => {
  it("returns one chunk for short text", () => {
    const chunks = chunkForStitching("Short sentence.");
    expect(chunks).toEqual(["Short sentence."]);
  });

  it("packs multiple sentences into a single chunk up to target", () => {
    const text = "First. Second. Third.";
    const chunks = chunkForStitching(text, { targetChars: 100 });
    expect(chunks).toEqual(["First. Second. Third."]);
  });

  it("splits when adding the next sentence would exceed target", () => {
    const text = "First sentence here. Second sentence here. Third sentence here.";
    const chunks = chunkForStitching(text, { targetChars: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 80)).toBe(true);
  });

  it("clause-splits a runaway sentence longer than maxChars", () => {
    const long = `${"word ".repeat(200)}done.`;
    const chunks = chunkForStitching(long, { targetChars: 300, maxChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Allow some slack — last-resort split may leave a chunk slightly over.
      expect(c.length).toBeLessThan(450);
    }
  });

  it("respects clause separators when available", () => {
    const sentence =
      "First clause is here; second clause continues the thought, and the third clause finishes; finally we end.";
    const chunks = chunkForStitching(sentence, { targetChars: 40, maxChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("returns empty array on empty/whitespace input", () => {
    expect(chunkForStitching("")).toEqual([]);
    expect(chunkForStitching("   \n\t  ")).toEqual([]);
  });

  it("reconstructs the original text content when joined (modulo whitespace)", () => {
    const text = "One. Two. Three. Four. Five.";
    const chunks = chunkForStitching(text, { targetChars: 12 });
    const rejoined = chunks.join(" ").replace(/\s+/g, " ");
    expect(rejoined).toBe(text.replace(/\s+/g, " "));
  });
});

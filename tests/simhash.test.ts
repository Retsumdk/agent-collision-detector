import { describe, expect, test } from "bun:test";
import { simhash, simhashSimilarity } from "../src/simhash.js";

describe("simhash", () => {
  test("identical text maps to identical fingerprints", () => {
    expect(simhash("refresh the pricing page index")).toBe(simhash("refresh the pricing page index"));
    expect(simhashSimilarity("refresh the pricing page index", "refresh the pricing page index")).toBe(1);
  });

  test("near-duplicates stay close, unrelated text diverges", () => {
    const near = simhashSimilarity(
      "refresh the pricing page index and report stale entries",
      "refresh the pricing page index and report stale entries now",
    );
    expect(near).toBeGreaterThan(0.8);
    const far = simhashSimilarity(
      "refresh the pricing page index and report stale entries",
      "compile the quarterly revenue projection spreadsheet for finance",
    );
    expect(far).toBeLessThan(0.6);
  });

  test("word order changes the fingerprint", () => {
    expect(simhash("agent one two three")).not.toBe(simhash("three two one agent"));
  });

  test("empty text yields the zero fingerprint deterministically", () => {
    expect(simhash("")).toBe(0n);
    expect(simhash("!!! ###")).toBe(0n);
    expect(simhashSimilarity("", "")).toBe(1);
  });
});

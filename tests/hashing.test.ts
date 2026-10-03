import { describe, expect, test } from "bun:test";
import { hash64, hamming64Bits, sha256Hex, constantTimeEqual } from "../src/hashing.js";

describe("hashing", () => {
  test("hash64 is deterministic and 64-bit ranged", () => {
    expect(hash64("agent-collision-detector")).toBe(hash64("agent-collision-detector"));
    const h = hash64("anything");
    expect(h).toBeGreaterThanOrEqual(0n);
    expect(h).toBeLessThanOrEqual(0xffff_ffff_ffff_ffffn);
  });

  test("different inputs hash differently", () => {
    expect(hash64("a")).not.toBe(hash64("b"));
    expect(hash64("a")).not.toBe(hash64("a ")); // trailing space changes bytes
  });

  test("hamming64Bits counts differing bits", () => {
    expect(hamming64Bits(0n, 0n)).toBe(0);
    expect(hamming64Bits(0n, 0xffff_ffff_ffff_ffffn)).toBe(64);
    expect(hamming64Bits(0b1010n, 0b0110n)).toBe(2);
  });

  test("sha256Hex is stable", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("constantTimeEqual compares exactly", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secreT")).toBe(false);
    expect(constantTimeEqual("short", "shorter")).toBe(false);
  });
});

import { createHash, timingSafeEqual } from "node:crypto";

const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const MASK64 = 0xffff_ffff_ffff_ffffn;

function fnv1a32(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, FNV_PRIME_32) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic 64-bit hash of a string, as a non-negative BigInt. */
export function hash64(input: string): bigint {
  const bytes = new TextEncoder().encode(input);
  const hi = BigInt(fnv1a32(bytes, FNV_OFFSET_32));
  const lo = BigInt(fnv1a32(bytes, FNV_OFFSET_32 ^ 0x9e37_79b9));
  return ((hi << 32n) | lo) & MASK64;
}

/** Hamming distance between two 64-bit values (count of differing bits). */
export function hamming64Bits(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

export const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

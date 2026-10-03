import { hamming64Bits, hash64 } from "./hashing.js";

const SIMHASH_BITS = 64n;

/**
 * 64-bit SimHash over word 1-grams and 2-grams. Structurally similar texts
 * land within a few bits of each other; the Hamming distance between two
 * fingerprints approximates textual dissimilarity.
 */
export function simhash(text: string): bigint {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return 0n;
  const weights = new Map<bigint, number>();
  for (let i = 0; i < tokens.length; i++) {
    const features = [tokens[i]!];
    if (i + 1 < tokens.length) features.push(`${tokens[i]}_${tokens[i + 1]}`);
    for (const feature of features) {
      const h = hash64(feature);
      weights.set(h, (weights.get(h) ?? 0) + 1);
    }
  }
  let fingerprint = 0n;
  for (let bit = 0n; bit < SIMHASH_BITS; bit++) {
    let sum = 0;
    for (const [h, weight] of weights) {
      sum += (h >> bit) & 1n ? weight : -weight;
    }
    if (sum > 0) fingerprint |= 1n << bit;
  }
  return fingerprint;
}

/** 0..1 similarity derived from Hamming distance (1 = identical fingerprints). */
export function simhashSimilarity(a: string, b: string): number {
  return 1 - hamming64Bits(simhash(a), simhash(b)) / 64;
}

import { describe, expect, test } from "bun:test";
import { LockRegistry } from "../src/lock.js";

function fakeClock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("LockRegistry", () => {
  test("exclusive blocks everything; shared coexists with shared only", () => {
    const { now } = fakeClock();
    const locks = new LockRegistry({ now, maxTtlMs: 60_000 });
    expect(locks.acquire("r", "a", { mode: "exclusive", ttlMs: 1_000 }).granted).toBe(true);
    expect(locks.acquire("r", "b", { mode: "shared", ttlMs: 1_000 }).granted).toBe(false);
    locks.release("r", "a");
    expect(locks.acquire("r", "b", { mode: "shared", ttlMs: 1_000 }).granted).toBe(true);
    expect(locks.acquire("r", "c", { mode: "shared", ttlMs: 1_000 }).granted).toBe(true);
    expect(locks.acquire("r", "d", { mode: "exclusive", ttlMs: 1_000 }).granted).toBe(false);
  });

  test("a holder re-acquiring with the same mode refreshes the lease", () => {
    const { now, advance } = fakeClock();
    const locks = new LockRegistry({ now, maxTtlMs: 60_000 });
    locks.acquire("r", "a", { mode: "exclusive", ttlMs: 1_000 });
    advance(500);
    const again = locks.acquire("r", "a", { mode: "exclusive", ttlMs: 1_000 });
    expect(again.granted).toBe(true);
    if (again.granted) expect(again.lease.expiresAt).toBe(now() + 1_000);
  });

  test("a mode upgrade by the sole holder is free; with peers it is blocked", () => {
    const { now } = fakeClock();
    const locks = new LockRegistry({ now, maxTtlMs: 60_000 });
    locks.acquire("r", "a", { mode: "shared", ttlMs: 1_000 });
    expect(locks.acquire("r", "a", { mode: "exclusive", ttlMs: 1_000 }).granted).toBe(true);
    locks.release("r", "a");
    locks.acquire("r", "a", { mode: "shared", ttlMs: 1_000 });
    locks.acquire("r", "b", { mode: "shared", ttlMs: 1_000 });
    expect(locks.acquire("r", "a", { mode: "exclusive", ttlMs: 1_000 }).granted).toBe(false);
  });

  test("expired leases are swept and release returns true only when something was removed", () => {
    const { now, advance } = fakeClock();
    const locks = new LockRegistry({ now, maxTtlMs: 60_000 });
    locks.acquire("r", "a", { mode: "exclusive", ttlMs: 500 });
    advance(600);
    expect(locks.inspect("r")).toEqual([]);
    expect(locks.resources()).toEqual([]);
    locks.acquire("s", "a", { mode: "exclusive", ttlMs: 5_000 });
    expect(locks.release("s", "b")).toBe(false);
    expect(locks.release("s", "a")).toBe(true);
    expect(locks.release("s", "a")).toBe(false);
  });

  test("ttl is capped at maxTtlMs", () => {
    const { now } = fakeClock();
    const locks = new LockRegistry({ now, maxTtlMs: 1_000 });
    const result = locks.acquire("r", "a", { mode: "exclusive", ttlMs: 999_999 });
    expect(result.granted).toBe(true);
    if (result.granted) expect(result.lease.expiresAt - now()).toBe(1_000);
  });

  test("validation rejects empty names and non-positive ttl", () => {
    const { now } = fakeClock();
    const locks = new LockRegistry({ now, maxTtlMs: 60_000 });
    expect(() => locks.acquire("", "a", { mode: "shared", ttlMs: 1 })).toThrow();
    expect(() => locks.acquire("r", "", { mode: "shared", ttlMs: 1 })).toThrow();
    expect(() => locks.acquire("r", "a", { mode: "shared", ttlMs: 0 })).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { LeaseRegistry } from "../src/lease.js";
import { DetectorError } from "../src/errors.js";

function fakeClock() {
  let t = 10_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("LeaseRegistry", () => {
  test("acquire, holderOf, renew and release follow claim identity", () => {
    const { now, advance } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    const claim = registry.acquire("db://orders", "agent-a", "write");
    expect(registry.holderOf("db://orders")?.agent).toBe("agent-a");
    expect(registry.holderOf("db://orders")?.mode).toBe("write");

    advance(1_000);
    const renewed = registry.renew(claim.id, "agent-a", 120_000);
    expect(renewed.expiresAt - now()).toBe(120_000);

    expect(() => registry.renew(claim.id, "agent-b", 1_000)).toThrow(DetectorError);
    const released = registry.release(claim.id, "agent-a");
    expect(released.releasedAt).toBe(now());
    expect(registry.holderOf("db://orders")).toBeUndefined();
  });

  test("a write claim conflicts with any live claim; reads coexist", () => {
    const { now } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    registry.acquire("r", "reader-1", "read");
    registry.acquire("r", "reader-2", "read");
    expect(() => registry.acquire("r", "writer", "write")).toThrow(DetectorError);
    expect(registry.live().filter((c) => c.mode === "read")).toHaveLength(2);
  });

  test("expired claims are swept and released claims cannot be reused", () => {
    const { now, advance } = fakeClock();
    const registry = new LeaseRegistry({ clock: now, ttlMs: 1_000 });
    const claim = registry.acquire("r", "a", "write");
    advance(1_500);
    expect(registry.holderOf("r")).toBeUndefined();
    expect(() => registry.release(claim.id, "a")).toThrow(DetectorError);
    const again = registry.acquire("r", "b", "write");
    expect(again.agent).toBe("b");
  });

  test("release by a non-owner is rejected", () => {
    const { now } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    const claim = registry.acquire("r", "a", "write");
    expect(() => registry.release(claim.id, "b")).toThrow(/belongs to/);
  });

  test("releasing a claim twice is rejected", () => {
    const { now } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    const claim = registry.acquire("r", "a", "read");
    registry.release(claim.id, "a");
    expect(() => registry.release(claim.id, "a")).toThrow(/already-released/);
  });

  test("deadlock cycle is detected in the wait-for graph", () => {
    const { now } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    registry.acquire("r1", "A", "write");
    registry.acquire("r2", "B", "write");
    const waiting = [
      { agent: "A", resource: "r2" },
      { agent: "B", resource: "r1" },
    ];
    expect(registry.detectDeadlock(waiting)).toEqual(["A", "B", "A"]);
  });

  test("an acyclic wait chain is not a deadlock", () => {
    const { now } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    registry.acquire("r1", "B", "write");
    registry.acquire("r2", "C", "write");
    const waiting = [
      { agent: "A", resource: "r1" },
      { agent: "B", resource: "r2" },
    ];
    expect(registry.detectDeadlock(waiting)).toEqual([]);
  });

  test("validation rejects empty resource or agent", () => {
    const { now } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    expect(() => registry.acquire("", "a", "read")).toThrow(DetectorError);
    expect(() => registry.acquire("r", "", "read")).toThrow(DetectorError);
  });

  test("negative ttl is rejected", () => {
    const { now } = fakeClock();
    const registry = new LeaseRegistry({ clock: now });
    expect(() => registry.acquire("r", "a", "read", -1)).toThrow(DetectorError);
  });
});

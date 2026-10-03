import { describe, expect, test } from "bun:test";
import { CollisionEngine } from "../src/engine.js";
import { DetectorError } from "../src/errors.js";

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}

const NEAR_A = "refresh the pricing page index and report stale entries";
const NEAR_B = "refresh the pricing page index and report stale entries now";
const UNRELATED = "compile the quarterly revenue projection spreadsheet";

describe("CollisionEngine", () => {
  test("first action on a resource is clean and takes a lease", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    const result = engine.record({ agent: "a", resource: "kb://home", kind: "write", intent: "rebuild the home page", at: clock.now(), target: "home" });
    expect(result.decision).toBe("accepted");
    expect(result.collisions).toEqual([]);
    expect(engine.stats().liveResources).toEqual(["kb://home"]);
  });

  test("resource contention: a second agent on an exclusive resource is flagged", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.record({ agent: "a", resource: "kb://home", kind: "write", intent: "rebuild the home page", at: clock.now() });
    const second = engine.record({ agent: "b", resource: "kb://home", kind: "write", intent: "restyle the home page", at: clock.now() + 1 });
    expect(second.decision).toBe("accepted");
    expect(second.collisions.map((c) => c.kind)).toContain("resource-contention");
    expect(second.collisions[0]!.severity).toBe("high");
    expect(second.collisions[0]!.recommended).toBe("queue");
    expect(second.collisions[0]!.agents).toEqual(["a", "b"]);
  });

  test("a shared-read policy lets readers coexist but still blocks writers", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.registerPolicy({ resource: "db://catalog", mode: "shared" });
    engine.record({ agent: "a", resource: "db://catalog", kind: "read", intent: "read the catalog", at: clock.now() });
    const secondRead = engine.record({ agent: "b", resource: "db://catalog", kind: "read", intent: "read the catalog", at: clock.now() + 1 });
    expect(secondRead.collisions.filter((c) => c.kind === "resource-contention")).toEqual([]);
    const write = engine.record({ agent: "c", resource: "db://catalog", kind: "write", intent: "rewrite the catalog", at: clock.now() + 2 });
    expect(write.collisions.map((c) => c.kind)).toContain("resource-contention");
  });

  test("the same agent refreshing its own resource is not self-contention", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.record({ agent: "a", resource: "r", kind: "write", intent: "first pass", at: clock.now() });
    const again = engine.record({ agent: "a", resource: "r", kind: "write", intent: "second pass", at: clock.now() + 5 });
    expect(again.collisions.filter((c) => c.kind === "resource-contention")).toEqual([]);
  });

  test("write-write on the same target is critical with a queue plan", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.record({ agent: "a", resource: "r1", kind: "write", intent: "update the orders table", at: clock.now(), target: "orders" });
    const result = engine.record({ agent: "b", resource: "r2", kind: "write", intent: "migrate the orders table", at: clock.now() + 10, target: "orders" });
    const ww = result.collisions.find((c) => c.kind === "write-write");
    expect(ww?.severity).toBe("critical");
    expect(result.plan?.strategy).toBe("queue");
    expect(result.plan?.detail).toContain("a -> b");
  });

  test("duplicate work merges near-identical intents from different agents", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, duplicateThreshold: 0.8, defaultLeaseTtlMs: 60_000 });
    engine.record({ agent: "scanner", resource: "kb://pages", kind: "read", intent: NEAR_A, at: clock.now() });
    const dup = engine.record({ agent: "scout", resource: "kb://other", kind: "read", intent: NEAR_B, at: clock.now() + 10 });
    const collision = dup.collisions.find((c) => c.kind === "duplicate-work");
    expect(collision?.recommended).toBe("merge");
    expect(collision?.evidence.similarity).toBeGreaterThan(0.8);
    expect(dup.plan?.strategy).toBe("merge");
  });

  test("dissimilar intents are not duplicates and the window expires", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, duplicateWindowMs: 1_000, defaultLeaseTtlMs: 60_000 });
    engine.record({ agent: "a", resource: "r1", kind: "read", intent: NEAR_A, at: clock.now() });
    const diff = engine.record({ agent: "b", resource: "r2", kind: "read", intent: UNRELATED, at: clock.now() + 10 });
    expect(diff.collisions.filter((c) => c.kind === "duplicate-work")).toEqual([]);
    clock.advance(2_000);
    const stale = engine.record({ agent: "c", resource: "r3", kind: "read", intent: NEAR_B, at: clock.now() });
    expect(stale.collisions.filter((c) => c.kind === "duplicate-work")).toEqual([]);
  });

  test("rate limits reject arrivals beyond the policy window", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.registerPolicy({ resource: "api://search", mode: "shared", rateLimitPerWindow: 2, windowMs: 60_000 });
    expect(engine.record({ agent: "a", resource: "api://search", kind: "read", intent: "search one", at: 10_000 }).decision).toBe("accepted");
    expect(engine.record({ agent: "b", resource: "api://search", kind: "read", intent: "search two", at: 20_000 }).decision).toBe("accepted");
    const third = engine.record({ agent: "c", resource: "api://search", kind: "read", intent: "search three", at: 30_000 });
    expect(third.decision).toBe("rejected");
    expect(third.reason).toContain("allows 2 actions per 60000ms");
    expect(third.collisions[0]!.kind).toBe("rate-limit");
    expect(third.plan?.strategy).toBe("shift");
    expect(third.plan?.detail).toContain("defer c by 60000ms");
    clock.advance(81_000);
    expect(engine.record({ agent: "c", resource: "api://search", kind: "read", intent: "search three", at: clock.now() }).decision).toBe("accepted");
  });

  test("rejected actions do not count toward the rate window", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.registerPolicy({ resource: "r", mode: "exclusive", rateLimitPerWindow: 1, windowMs: 1_000 });
    engine.record({ agent: "a", resource: "r", kind: "read", intent: "one", at: 0 });
    expect(engine.record({ agent: "b", resource: "r", kind: "read", intent: "two", at: 100 }).decision).toBe("rejected");
    expect(engine.record({ agent: "b", resource: "r", kind: "read", intent: "two again", at: 200 }).decision).toBe("rejected");
    clock.advance(1_100);
    expect(engine.record({ agent: "b", resource: "r", kind: "read", intent: "three", at: clock.now() }).decision).toBe("accepted");
  });

  test("read/write races on one target are flagged low-severity", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.record({ agent: "reader", resource: "r", kind: "read", intent: "inspect the config", at: 0, target: "config" });
    const writer = engine.record({ agent: "writer", resource: "r2", kind: "write", intent: "rewrite the config", at: 10, target: "config" });
    const rw = writer.collisions.find((c) => c.kind === "read-write");
    expect(rw?.severity).toBe("low");
    expect(rw?.agents).toEqual(["reader", "writer"]);
  });

  test("release frees the resource and stats track history", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000 });
    engine.record({ agent: "a", resource: "r", kind: "write", intent: "hold it", at: clock.now() });
    expect(engine.release("r", "a")).toBe(true);
    expect(engine.release("r", "a")).toBe(false);
    const fresh = engine.record({ agent: "b", resource: "r", kind: "write", intent: "take over", at: clock.now() + 1 });
    expect(fresh.collisions.filter((c) => c.kind === "resource-contention")).toEqual([]);
    const stats = engine.stats();
    expect(stats.actionsRecorded).toBe(2);
    expect(stats.collisionsEmitted).toBe(0);
  });

  test("invalid actions throw VALIDATION errors", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now });
    expect(() => engine.record({ agent: "", resource: "r", kind: "write", intent: "x", at: 0 })).toThrow(DetectorError);
    expect(() => engine.record({ agent: "a", resource: "", kind: "write", intent: "x", at: 0 })).toThrow(DetectorError);
    expect(() => engine.record({ agent: "a", resource: "r", kind: "write", intent: "", at: 0 })).toThrow(DetectorError);
    expect(() => engine.record({ agent: "a", resource: "r", kind: "upsert" as "write", intent: "x", at: 0 })).toThrow(DetectorError);
    expect(() => engine.record({ agent: "a", resource: "r", kind: "write", intent: "x", at: Number.NaN })).toThrow(DetectorError);
  });

  test("history is trimmed to maxHistory", () => {
    const clock = fakeClock();
    const engine = new CollisionEngine({ now: clock.now, defaultLeaseTtlMs: 60_000, maxHistory: 3 });
    for (let i = 0; i < 5; i++) {
      engine.record({ agent: `a${i}`, resource: `r${i}`, kind: "read", intent: `intent ${i}`, at: clock.now() + i });
    }
    expect(engine.stats().actionsRecorded).toBe(3);
  });
});

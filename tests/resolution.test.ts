import { describe, expect, test } from "bun:test";
import { resolveCollision } from "../src/resolution.js";
import type { AgentAction, Collision } from "../src/types.js";

const actions: AgentAction[] = [
  { agent: "zeta", resource: "r", kind: "write", intent: "do the thing", at: 200, target: "e" },
  { agent: "alpha", resource: "r", kind: "write", intent: "do the thing", at: 100, target: "e" },
];

function collision(kind: Collision["kind"], evidence: Collision["evidence"] = {}, agents = ["alpha", "zeta"]): Collision {
  return { kind, severity: "high", message: "m", agents, resource: "r", evidence, recommended: "queue" };
}

describe("resolveCollision", () => {
  test("contention queues in arrival order with timestamps", () => {
    const plan = resolveCollision(collision("resource-contention"), actions);
    expect(plan.strategy).toBe("queue");
    expect(plan.detail).toBe("grant order: alpha@100 -> zeta@200");
  });

  test("write-write serializes writers deterministically", () => {
    const plan = resolveCollision(collision("write-write", { target: "e" }), actions);
    expect(plan.strategy).toBe("queue");
    expect(plan.detail).toContain("alpha");
    expect(plan.detail).toContain("zeta");
  });

  test("duplicate-work merges the later agent into the first mover", () => {
    const plan = resolveCollision(collision("duplicate-work", { similarity: 0.95 }), actions);
    expect(plan.strategy).toBe("merge");
    expect(plan.detail).toBe("dedupe: zeta subscribes to alpha's run");
  });

  test("rate-limit shifts by the policy window", () => {
    const plan = resolveCollision(collision("rate-limit", { windowMs: 60_000 }, ["zeta"]), [actions[1]!]);
    expect(plan.strategy).toBe("shift");
    expect(plan.detail).toBe("defer zeta by 60000ms");
  });

  test("read-write names the pending readers", () => {
    const reads: AgentAction[] = [
      { agent: "alpha", resource: "r", kind: "read", intent: "inspect", at: 100, target: "e" },
    ];
    const plan = resolveCollision(collision("read-write", {}, ["alpha", "zeta"]), reads);
    expect(plan.strategy).toBe("shift");
    expect(plan.detail).toBe("readers: alpha");
  });
});

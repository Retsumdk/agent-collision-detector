import type { AgentAction, Collision, ResolutionStrategy } from "./types.js";

export interface ResolutionPlan {
  readonly strategy: ResolutionStrategy;
  readonly rationale: string;
  /** Concrete detail: grant order, defer offset, merge pairing. */
  readonly detail: string;
}

/**
 * Picks a concrete remediation for a collision. Deterministic: same inputs
 * always yield the same plan, so callers can replay decisions.
 */
export function resolveCollision(collision: Collision, actions: AgentAction[]): ResolutionPlan {
  const sorted = [...actions].sort((a, b) => a.at - b.at || a.agent.localeCompare(b.agent));
  const first = sorted[0];
  switch (collision.kind) {
    case "resource-contention": {
      const order = collision.agents.map((agent) => {
        const action = sorted.find((a) => a.agent === agent);
        return action ? `${agent}@${action.at}` : agent;
      });
      return {
        strategy: "queue",
        rationale: "Exclusive resource already held; serialize the claimants.",
        detail: `grant order: ${order.join(" -> ")}`,
      };
    }
    case "write-write":
      return {
        strategy: "queue",
        rationale: "Two agents intend to mutate the same entity; serialize writes.",
        detail: `writer order: ${sorted.map((a) => a.agent).join(" -> ")}`,
      };
    case "duplicate-work": {
      const second = sorted[1];
      return {
        strategy: "merge",
        rationale: "Intents are near-identical; one execution can serve both agents.",
        detail: second
          ? `dedupe: ${second.agent} subscribes to ${first?.agent ?? "the first mover"}'s run`
          : "insufficient actions to merge",
      };
    }
    case "rate-limit": {
      const evidence = collision.evidence;
      const windowMs = typeof evidence.windowMs === "number" ? evidence.windowMs : 60_000;
      const last = collision.agents[collision.agents.length - 1] ?? "arrival";
      return {
        strategy: "shift",
        rationale: "Policy rate limit reached; defer the latest arrival.",
        detail: `defer ${last} by ${windowMs}ms`,
      };
    }
    case "read-write":
      return {
        strategy: "shift",
        rationale: "A write is pending against an entity being read; order reads before the write.",
        detail: `readers: ${sorted.filter((a) => a.kind === "read").map((a) => a.agent).join(", ") || "none"}`,
      };
  }
}

import type { LockMode } from "./lock.js";

export type ActionKind = "read" | "write";

export interface AgentAction {
  readonly agent: string;
  readonly resource: string;
  readonly kind: ActionKind;
  /** What the agent says it will do; drives duplicate-work detection. */
  readonly intent: string;
  /** Logical entity being mutated; write conflicts key on this. */
  readonly target?: string | undefined;
  readonly at: number;
}

export interface ResourcePolicy {
  /** Exact resource key the policy applies to. */
  readonly resource: string;
  readonly mode: LockMode;
  /** Max actions on this resource per window; Infinity = unbounded. */
  readonly rateLimitPerWindow?: number | undefined;
  /** Rate window in milliseconds (default 60_000). */
  readonly windowMs?: number | undefined;
}

export type CollisionKind =
  | "resource-contention"
  | "write-write"
  | "duplicate-work"
  | "rate-limit"
  | "read-write";

export type ResolutionStrategy =
  | "queue"
  | "shift"
  | "reassign"
  | "merge"
  | "reject";

export interface Collision {
  readonly kind: CollisionKind;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly message: string;
  readonly agents: string[];
  readonly resource: string;
  readonly evidence: Record<string, string | number | boolean>;
  readonly recommended: ResolutionStrategy;
}

/** Lease-registry access mode for a claim on a resource. */
export type AccessMode = "read" | "write";

export interface Claim {
  readonly id: string;
  readonly resource: string;
  readonly agent: string;
  readonly mode: AccessMode;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly releasedAt?: number | undefined;
}

export interface EngineStats {
  readonly actionsRecorded: number;
  readonly collisionsEmitted: number;
  readonly liveResources: string[];
}

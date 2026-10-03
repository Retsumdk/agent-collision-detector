import { DetectorError } from "./errors.js";
import { LockRegistry, type Lease, type LockMode } from "./lock.js";
import { PolicyTable } from "./policies.js";
import { simhashSimilarity } from "./simhash.js";
import { resolveCollision, type ResolutionPlan } from "./resolution.js";
import type { AgentAction, Collision, EngineStats, ResourcePolicy } from "./types.js";

export interface EngineOptions {
  now: () => number;
  /** Intents more recent than this are eligible for similarity matching. */
  duplicateWindowMs?: number;
  /** Opposite-kind actions within this window of a target count as races. */
  writeWindowMs?: number;
  /** SimHash similarity at or above which two intents count as duplicates. */
  duplicateThreshold?: number;
  /** Lease TTL taken by each accepted action. */
  defaultLeaseTtlMs?: number;
  /** Cap on any lease lifetime regardless of requested TTL. */
  maxTtlMs?: number;
  maxHistory?: number;
}

export interface EngineSnapshot {
  readonly history: readonly AgentAction[];
  readonly leases: readonly Lease[];
}

export interface RecordResult {
  readonly decision: "accepted" | "rejected";
  readonly reason?: string;
  readonly collisions: Collision[];
  readonly plan?: ResolutionPlan;
}

const SEVERITY_ORDER: Record<Collision["severity"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function worst(collisions: Collision[]): Collision | undefined {
  return [...collisions].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])[0];
}

/**
 * Records agent actions and flags collisions across five classes:
 *
 * - resource-contention — the resource is held by another live lease
 * - write-write — two agents recently wrote (or intend to write) the same entity
 * - duplicate-work — near-identical intents from different agents (SimHash)
 * - rate-limit — a policy rate limit for the resource was exceeded (rejected)
 * - read-write — a read races a recent write on the same entity
 *
 * Everything is advisory except rate limits, which reject the arriving
 * action outright. Accepted actions hold a lease on their resource for
 * `defaultLeaseTtlMs`, so later arrivals see the contention.
 */
export class CollisionEngine {
  readonly policies = new PolicyTable();
  readonly locks: LockRegistry;

  private readonly duplicateWindowMs: number;
  private readonly writeWindowMs: number;
  private readonly duplicateThreshold: number;
  private readonly defaultLeaseTtlMs: number;
  private readonly maxHistory: number;
  private readonly history: AgentAction[] = [];
  private countEmitted = 0;

  constructor(opts: EngineOptions) {
    this.duplicateWindowMs = opts.duplicateWindowMs ?? 30 * 60_000;
    this.writeWindowMs = opts.writeWindowMs ?? 10 * 60_000;
    this.duplicateThreshold = opts.duplicateThreshold ?? 0.9;
    this.defaultLeaseTtlMs = opts.defaultLeaseTtlMs ?? 5 * 60_000;
    this.maxHistory = opts.maxHistory ?? 5000;
    this.locks = new LockRegistry({
      now: opts.now,
      maxTtlMs: opts.maxTtlMs ?? 24 * 60 * 60_000,
    });
  }

  registerPolicy(policy: ResourcePolicy): void {
    this.policies.register(policy);
  }

  private recentWithin(windowMs: number, at: number): AgentAction[] {
    const cutoff = at - windowMs;
    return this.history.filter((a) => a.at >= cutoff);
  }

  private detectRateLimit(action: AgentAction): Collision | undefined {
    const policy = this.policies.lookup(action.resource);
    const limit = policy?.rateLimitPerWindow;
    if (limit === undefined || !Number.isFinite(limit)) return undefined;
    const windowMs = policy?.windowMs ?? 60_000;
    const inWindow = this.recentWithin(windowMs, action.at).filter(
      (a) => a.resource === action.resource,
    );
    if (inWindow.length < limit) return undefined;
    return {
      kind: "rate-limit",
      severity: "medium",
      message: `policy for ${action.resource} allows ${limit} actions per ${windowMs}ms; ${inWindow.length} already recorded`,
      agents: [...new Set([...inWindow.map((a) => a.agent), action.agent])],
      resource: action.resource,
      evidence: { limit, windowMs, observed: inWindow.length },
      recommended: "shift",
    };
  }

  private detectContention(action: AgentAction, policyMode: LockMode): Collision | undefined {
    const leaseMode: LockMode =
      action.kind === "write" ? "exclusive" : policyMode;
    const result = this.locks.acquire(action.resource, action.agent, {
      mode: leaseMode,
      ttlMs: this.defaultLeaseTtlMs,
    });
    if (result.granted) return undefined;
    const holders = result.blockedBy.map(
      (l) => `${l.holder} (${l.mode}, expires ${l.expiresAt})`,
    );
    return {
      kind: "resource-contention",
      severity: "high",
      message: `${action.resource} is held by ${result.blockedBy
        .map((l) => l.holder)
        .join(", ")} under ${leaseMode} policy`,
      agents: [...new Set([...result.blockedBy.map((l) => l.holder), action.agent])],
      resource: action.resource,
      evidence: { holders: holders.join("; "), requestedMode: leaseMode },
      recommended: "queue",
    };
  }

  private detectWriteWrite(action: AgentAction): Collision | undefined {
    if (action.kind !== "write" || action.target === undefined) return undefined;
    const pending = this.recentWithin(this.writeWindowMs, action.at).filter(
      (a) => a.kind === "write" && a.target === action.target && a.agent !== action.agent,
    );
    if (pending.length === 0) return undefined;
    return {
      kind: "write-write",
      severity: "critical",
      message: `${pending.length} recent write(s) by ${[...new Set(pending.map((a) => a.agent))].join(
        ", ",
      )} target the same entity ${action.target}`,
      agents: [...new Set([...pending.map((a) => a.agent), action.agent])],
      resource: action.resource,
      evidence: {
        target: action.target,
        lastWriteAt: Math.max(...pending.map((a) => a.at)),
      },
      recommended: "queue",
    };
  }

  private detectDuplicateWork(action: AgentAction): Collision | undefined {
    const recent = this.recentWithin(this.duplicateWindowMs, action.at).filter(
      (a) => a.agent !== action.agent && a.intent.length > 0 && action.intent.length > 0,
    );
    let best: { other: AgentAction; similarity: number } | undefined;
    for (const other of recent) {
      const similarity = simhashSimilarity(action.intent, other.intent);
      if (similarity >= this.duplicateThreshold && (best === undefined || similarity > best.similarity)) {
        best = { other, similarity };
      }
    }
    if (best === undefined) return undefined;
    return {
      kind: "duplicate-work",
      severity: "medium",
      message: `intent matches ${best.other.agent} at ${(best.similarity * 100).toFixed(1)}% SimHash similarity`,
      agents: [best.other.agent, action.agent],
      resource: action.resource,
      evidence: {
        similarity: Number(best.similarity.toFixed(4)),
        matchedIntent: best.other.intent,
      },
      recommended: "merge",
    };
  }

  private detectReadWrite(action: AgentAction): Collision | undefined {
    if (action.target === undefined) return undefined;
    const others = this.recentWithin(this.writeWindowMs, action.at).filter(
      (a) => a.target === action.target && a.agent !== action.agent && a.kind !== action.kind,
    );
    if (others.length === 0) return undefined;
    return {
      kind: "read-write",
      severity: "low",
      message: `${action.kind} on ${action.target} races ${others.length} opposite-kind action(s) within ${this.writeWindowMs}ms`,
      agents: [...new Set([...others.map((a) => a.agent), action.agent])],
      resource: action.resource,
      evidence: { target: action.target, opposites: others.length },
      recommended: "shift",
    };
  }

  record(action: AgentAction): RecordResult {
    if (action.agent.length === 0 || action.resource.length === 0 || action.intent.length === 0) {
      throw new DetectorError("VALIDATION", "agent, resource and intent must be non-empty");
    }
    if (action.kind !== "read" && action.kind !== "write") {
      throw new DetectorError("VALIDATION", `invalid kind "${String(action.kind)}"`);
    }
    if (!Number.isFinite(action.at)) {
      throw new DetectorError("VALIDATION", "at must be a finite timestamp");
    }

    const rate = this.detectRateLimit(action);
    if (rate !== undefined) {
      this.countEmitted += 1;
      return {
        decision: "rejected",
        reason: rate.message,
        collisions: [rate],
        plan: resolveCollision(rate, this.relevantActions(rate, action.at)),
      };
    }

    const collisions: Collision[] = [];
    const policyMode = this.policies.lookup(action.resource)?.mode ?? "exclusive";
    const contention = this.detectContention(action, policyMode);
    if (contention !== undefined) collisions.push(contention);

    const writeWrite = this.detectWriteWrite(action);
    if (writeWrite !== undefined) collisions.push(writeWrite);

    const duplicate = this.detectDuplicateWork(action);
    if (duplicate !== undefined) collisions.push(duplicate);

    const rw = this.detectReadWrite(action);
    if (rw !== undefined) collisions.push(rw);

    this.history.push(action);
    this.trim();
    this.countEmitted += collisions.length;

    const top = worst(collisions);
    return {
      decision: "accepted",
      collisions,
      ...(top === undefined ? {} : { plan: resolveCollision(top, this.relevantActions(top, action.at)) }),
    };
  }

  private relevantActions(collision: Collision, at: number): AgentAction[] {
    const window = Math.max(this.writeWindowMs, this.duplicateWindowMs);
    return this.recentWithin(window, at).filter((a) => collision.agents.includes(a.agent));
  }

  private trim(): void {
    while (this.history.length > this.maxHistory) this.history.shift();
  }

  release(resource: string, holder: string): boolean {
    return this.locks.release(resource, holder);
  }

  /** Serializable state for CLI --state persistence. */
  snapshot(): EngineSnapshot {
    const leases: Lease[] = [];
    for (const resource of this.locks.resources()) leases.push(...this.locks.inspect(resource));
    return { history: [...this.history], leases };
  }

  /** Re-instate a snapshot produced by snapshot(); conflict checks are skipped. */
  restore(snapshot: EngineSnapshot): void {
    for (const action of snapshot.history) {
      if (action.agent.length === 0 || action.resource.length === 0 || action.intent.length === 0) {
        throw new DetectorError("VALIDATION", "snapshot history contains an invalid action");
      }
    }
    this.history.push(...snapshot.history);
    this.trim();
    for (const lease of snapshot.leases) this.locks.restoreLease(lease);
  }

  stats(): EngineStats {
    return {
      actionsRecorded: this.history.length,
      collisionsEmitted: this.countEmitted,
      liveResources: this.locks.resources(),
    };
  }
}

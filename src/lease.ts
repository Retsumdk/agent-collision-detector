import { DetectorError } from "./errors.js";
import type { AccessMode, Claim } from "./types.js";

export interface LeaseOptions {
  /** Claim TTL in ms. Default 60_000. */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  clock?: () => number;
  idGenerator?: () => string;
}

/**
 * Resource claim registry with wait-for-graph deadlock detection.
 * A claim is advisory: the registry records who holds what and answers
 * "if these agents are waiting on these resources, is there a cycle?"
 */
export class LeaseRegistry {
  private claims = new Map<string, Claim>();
  private seq = 0;
  private readonly clock: () => number;
  private readonly idGenerator: () => string;
  private readonly defaultTtlMs: number;

  constructor(options: LeaseOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idGenerator = options.idGenerator ?? (() => `lease-${++this.seq}`);
    this.defaultTtlMs = options.ttlMs ?? 60_000;
  }

  private activeClaims(): Claim[] {
    const now = this.clock();
    return [...this.claims.values()].filter(
      (c) => c.releasedAt === undefined && c.expiresAt > now,
    );
  }

  live(): Claim[] {
    const now = this.clock();
    for (const [id, claim] of this.claims) {
      if (claim.expiresAt <= now) this.claims.delete(id);
    }
    return this.activeClaims();
  }

  /** Acquire a claim; throws CONFLICT if any live claim exists on the resource. */
  acquire(resource: string, agent: string, mode: AccessMode, ttlMs?: number): Claim {
    if (resource.length === 0) throw new DetectorError("VALIDATION", "resource must be non-empty");
    if (agent.length === 0) throw new DetectorError("VALIDATION", "agent must be non-empty");
    const now = this.clock();
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new DetectorError("VALIDATION", `ttlMs must be a non-negative finite number, got ${ttl}`);
    }
    for (const claim of this.live()) {
      if (claim.resource !== resource || claim.agent === agent) continue;
      const blocks = mode === "write" || claim.mode === "write";
      if (!blocks) continue;
      throw new DetectorError("CONFLICT", 
        `resource "${resource}" is held by agent "${claim.agent}" (claim ${claim.id}, ` +
          `mode ${claim.mode}, expires ${claim.expiresAt})`,
      );
    }
    const claim: Claim = {
      id: this.idGenerator(),
      resource,
      agent,
      mode,
      acquiredAt: now,
      expiresAt: now + ttl,
    };
    this.claims.set(claim.id, claim);
    return claim;
  }

  release(claimId: string, agent: string): Claim {
    const claim = this.claims.get(claimId);
    if (!claim || claim.releasedAt !== undefined) {
      throw new DetectorError("VALIDATION", `unknown or already-released claim "${claimId}"`);
    }
    if (claim.agent !== agent) {
      throw new DetectorError("VALIDATION", `claim "${claimId}" belongs to "${claim.agent}", not "${agent}"`);
    }
    const released = { ...claim, releasedAt: this.clock() };
    this.claims.set(claimId, released);
    return released;
  }

  renew(claimId: string, agent: string, ttlMs: number): Claim {
    const claim = this.claims.get(claimId);
    if (!claim || claim.releasedAt !== undefined) {
      throw new DetectorError("VALIDATION", `unknown or already-released claim "${claimId}"`);
    }
    if (claim.agent !== agent) {
      throw new DetectorError("VALIDATION", `claim "${claimId}" belongs to "${claim.agent}", not "${agent}"`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new DetectorError("VALIDATION", `ttlMs must be a non-negative finite number, got ${ttlMs}`);
    }
    const renewed = { ...claim, expiresAt: this.clock() + ttlMs };
    this.claims.set(claimId, renewed);
    return renewed;
  }

  holderOf(resource: string): Claim | undefined {
    return this.live().find((c) => c.resource === resource);
  }

  /**
   * Deadlock detection over the wait-for graph: agent A waits on resource R
   * if A requested R while a live claim on R is held by another agent.
   * A cycle in that graph is a deadlock. Returns one representative cycle
   * (empty when the graph is acyclic).
   */
  detectDeadlock(waiting: ReadonlyArray<{ agent: string; resource: string }>): string[] {
    const waitsFor = new Map<string, Set<string>>();
    const live = this.live();
    for (const w of waiting) {
      for (const claim of live) {
        if (claim.resource === w.resource && claim.agent !== w.agent) {
          const set = waitsFor.get(w.agent) ?? new Set<string>();
          set.add(claim.agent);
          waitsFor.set(w.agent, set);
        }
      }
    }
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    let cycle: string[] | undefined;

    const visit = (node: string): void => {
      if (cycle) return;
      color.set(node, GRAY);
      stack.push(node);
      for (const next of waitsFor.get(node) ?? []) {
        const state = color.get(next) ?? WHITE;
        if (state === GRAY) {
          cycle = [...stack.slice(stack.indexOf(next)), next];
          return;
        }
        if (state === WHITE) visit(next);
        if (cycle) return;
      }
      stack.pop();
      color.set(node, BLACK);
    };

    for (const agent of waitsFor.keys()) {
      if ((color.get(agent) ?? WHITE) === WHITE) visit(agent);
      if (cycle) break;
    }
    return cycle ?? [];
  }
}

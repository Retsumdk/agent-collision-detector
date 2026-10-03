import { DetectorError } from "./errors.js";

export type LockMode = "exclusive" | "shared";

export interface Lease {
  readonly resource: string;
  readonly holder: string;
  readonly mode: LockMode;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export interface ClaimOptions {
  mode: LockMode;
  ttlMs: number;
}

export interface LockOptions {
  now: () => number;
  /** Cap on any lease lifetime regardless of the requested TTL. */
  maxTtlMs: number;
}

export type AcquireResult =
  | { granted: true; lease: Lease }
  | { granted: false; blockedBy: Lease[] };

/**
 * Registry of live resource leases with TTL expiry and shared/exclusive
 * modes. A shared lease coexists with other shared leases; it conflicts with
 * any exclusive lease. An exclusive lease conflicts with everything.
 */
export class LockRegistry {
  private readonly leases = new Map<string, Lease[]>();
  private readonly now: () => number;
  private readonly maxTtlMs: number;

  constructor(opts: LockOptions) {
    this.now = opts.now;
    this.maxTtlMs = opts.maxTtlMs;
  }

  private sweep(resource: string): void {
    const list = this.leases.get(resource);
    if (!list) return;
    const t = this.now();
    const live = list.filter((l) => l.expiresAt > t);
    if (live.length === 0) this.leases.delete(resource);
    else this.leases.set(resource, live);
  }

  private live(resource: string): Lease[] {
    this.sweep(resource);
    return this.leases.get(resource) ?? [];
  }

  /** True when a candidate claim in `mode` may coexist with `lease`. */
  private static compatible(mode: LockMode, lease: Lease): boolean {
    return mode === "shared" && lease.mode === "shared";
  }

  acquire(resource: string, holder: string, opts: ClaimOptions): AcquireResult {
    if (resource.length === 0 || holder.length === 0) {
      throw new DetectorError("VALIDATION", "resource and holder must be non-empty");
    }
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new DetectorError("VALIDATION", "ttlMs must be a positive number");
    }
    const ttl = Math.min(opts.ttlMs, this.maxTtlMs);
    const current = this.live(resource);

    // A re-claim by the existing holder refreshes its TTL (same mode required
    // unless the holder is the sole live lease, in which case upgrades are free).
    const mine = current.filter((l) => l.holder === holder);
    if (mine.length > 0) {
      const soleHolder = mine.length === current.length;
      const sameMode = mine[0]!.mode === opts.mode;
      if (sameMode) {
        const t = this.now();
        const refreshed: Lease = {
          resource,
          holder,
          mode: opts.mode,
          acquiredAt: mine[0]!.acquiredAt,
          expiresAt: t + ttl,
        };
        this.leases.set(resource, [refreshed]);
        return { granted: true, lease: refreshed };
      }
      if (!soleHolder) return { granted: false, blockedBy: current };
      const t = this.now();
      const upgraded: Lease = {
        resource,
        holder,
        mode: opts.mode,
        acquiredAt: mine[0]!.acquiredAt,
        expiresAt: t + ttl,
      };
      this.leases.set(resource, [upgraded]);
      return { granted: true, lease: upgraded };
    }

    const blocked = current.filter((l) => !LockRegistry.compatible(opts.mode, l));
    if (blocked.length > 0) return { granted: false, blockedBy: current };

    const t = this.now();
    const lease: Lease = { resource, holder, mode: opts.mode, acquiredAt: t, expiresAt: t + ttl };
    const next = current.filter((l) => l.holder !== holder);
    next.push(lease);
    this.leases.set(resource, next);
    return { granted: true, lease };
  }

  /** Re-instate a previously live lease (state restore). No conflict checks. */
  restoreLease(lease: Lease): void {
    if (!Number.isFinite(lease.acquiredAt) || !Number.isFinite(lease.expiresAt)) {
      throw new DetectorError("VALIDATION", "lease timestamps must be finite");
    }
    const list = this.leases.get(lease.resource) ?? [];
    list.push({ ...lease });
    this.leases.set(lease.resource, list);
  }

  release(resource: string, holder: string): boolean {
    const list = this.leases.get(resource);
    if (!list) return false;
    const after = list.filter((l) => l.holder !== holder);
    if (after.length === 0) this.leases.delete(resource);
    else this.leases.set(resource, after);
    return after.length < list.length;
  }

  inspect(resource: string): Lease[] {
    return [...this.live(resource)];
  }

  resources(): string[] {
    const keys = new Set<string>();
    for (const key of this.leases.keys()) {
      this.sweep(key);
      if (this.leases.has(key)) keys.add(key);
    }
    return [...keys].sort();
  }
}

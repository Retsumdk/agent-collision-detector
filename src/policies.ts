import { DetectorError } from "./errors.js";
import type { ResourcePolicy } from "./types.js";

const VALID_MODES = new Set(["exclusive", "shared"]);

/**
 * Registry of per-resource policies. The default for any resource without a
 * policy is `exclusive` with no rate limit, enforced by the engine.
 */
export class PolicyTable {
  private readonly policies = new Map<string, ResourcePolicy>();

  register(policy: ResourcePolicy): void {
    if (typeof policy.resource !== "string" || policy.resource.length === 0) {
      throw new DetectorError("VALIDATION", "policy resource must be a non-empty string");
    }
    if (!VALID_MODES.has(policy.mode)) {
      throw new DetectorError("VALIDATION", `invalid mode "${String(policy.mode)}" (expected "exclusive" or "shared")`);
    }
    if (policy.rateLimitPerWindow !== undefined) {
      const limit = policy.rateLimitPerWindow;
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new DetectorError("VALIDATION", "rateLimitPerWindow must be a positive finite number");
      }
    }
    if (policy.windowMs !== undefined) {
      const window = policy.windowMs;
      if (!Number.isFinite(window) || window <= 0) {
        throw new DetectorError("VALIDATION", "windowMs must be a positive finite number");
      }
    }
    this.policies.set(policy.resource, policy);
  }

  lookup(resource: string): ResourcePolicy | undefined {
    return this.policies.get(resource);
  }

  list(): ResourcePolicy[] {
    return [...this.policies.values()].sort((a, b) => a.resource.localeCompare(b.resource));
  }
}

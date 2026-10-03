import { CollisionEngine } from "./engine.js";
import { AuditLog } from "./audit.js";
import type { AgentAction } from "./types.js";

export interface DemoLine {
  readonly label: string;
  readonly text: string;
}

export interface DemoRun {
  readonly lines: DemoLine[];
}

/**
 * A scripted, fully deterministic tour of the engine: a fixed clock, three
 * agents, one shared target, one rate-limited API. Every collision class the
 * engine detects appears exactly once, and the audit ledger verifies intact
 * at the end. No wall-clock anywhere — re-running produces byte-identical
 * output.
 */
export function runDemo(): DemoRun {
  const lines: DemoLine[] = [];
  let t = 0;
  const now = (): number => t;
  const engine = new CollisionEngine({ now, defaultLeaseTtlMs: 10 * 60_000 });
  const audit = new AuditLog(undefined, now);
  const check = (action: AgentAction): void => {
    const result = engine.record(action);
    audit.recordCollision(action, result.collisions, result.decision);
    const kinds =
      result.collisions.length === 0
        ? "no collisions"
        : result.collisions.map((c) => `${c.kind} (${c.severity})`).join(", ");
    lines.push({
      label: `t=${action.at} ${action.agent} ${action.kind} ${action.resource}`,
      text: `${result.decision} — ${kinds}${result.plan ? `; plan: ${result.plan.strategy} — ${result.plan.detail}` : ""}${result.reason ? `; reason: ${result.reason}` : ""}`,
    });
    t += 2_000;
  };

  engine.registerPolicy({ resource: "api://search", mode: "shared", rateLimitPerWindow: 2, windowMs: 60_000 });

  check({ agent: "scanner", resource: "kb://pages/home", kind: "write", intent: "rebuild the home page index and refresh stale links", target: "home", at: t });
  check({ agent: "writer", resource: "kb://pages/home", kind: "write", intent: "restructure the home page layout and rewrite the hero copy", target: "home", at: t });
  check({ agent: "scout", resource: "kb://pages/home", kind: "read", intent: "rebuild the home page index and refresh stale links", at: t });
  check({ agent: "reader", resource: "api://search", kind: "read", intent: "search the catalog for pricing pages", at: t });
  check({ agent: "reader", resource: "api://search", kind: "read", intent: "search the catalog for billing pages", at: t });
  check({ agent: "reader", resource: "api://search", kind: "read", intent: "search the catalog for onboarding pages", at: t });

  lines.push({ label: "audit", text: JSON.stringify(audit.verify()) });
  lines.push({ label: "stats", text: JSON.stringify(engine.stats()) });
  return { lines };
}

/** Renders a run as printable lines. */
export function renderDemo(run: DemoRun): string[] {
  return run.lines.map((line) => `[${line.label}] ${line.text}`);
}

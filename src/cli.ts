#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CollisionEngine } from "./engine.js";
import { AuditLog } from "./audit.js";
import { runDemo, renderDemo } from "./demo.js";
import { loadConfig } from "./config.js";
import { DetectorError } from "./errors.js";
import type { AgentAction } from "./types.js";
import type { EngineSnapshot } from "./engine.js";
import type { Lease } from "./lock.js";

export type LogFn = (line: string) => void;

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new DetectorError("VALIDATION", `--${flag} is required`);
  }
  return value;
}

function numberValue(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new DetectorError("VALIDATION", `--${flag} must be a finite number`);
  return n;
}

function actionFromFlags(values: Record<string, string | string[] | boolean | undefined>): AgentAction {
  const agent = requireValue(values["agent"] as string | undefined, "agent");
  const resource = requireValue(values["resource"] as string | undefined, "resource");
  const kind = requireValue(values["kind"] as string | undefined, "kind");
  if (kind !== "read" && kind !== "write") {
    throw new DetectorError("VALIDATION", `--kind must be "read" or "write", got "${kind}"`);
  }
  const intent = requireValue(values["intent"] as string | undefined, "intent");
  const at = numberValue(values["at"] as string | undefined, "at") ?? Date.now();
  const target = values["target"] as string | undefined;
  return {
    agent,
    resource,
    kind,
    intent,
    at,
    ...(target !== undefined && target.length > 0 ? { target } : {}),
  };
}

interface PersistedState {
  version: 1;
  history: AgentAction[];
  leases: Lease[];
}

function loadStateFile(engine: CollisionEngine, statePath: string): void {
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as { history?: AgentAction[]; leases?: Lease[] };
    engine.restore({
      history: Array.isArray(parsed["history"]) ? parsed["history"] : [],
      leases: Array.isArray(parsed["leases"]) ? parsed["leases"] : [],
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DetectorError("VALIDATION", `cannot load state file "${statePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function writeStateFile(path: string, snapshot: EngineSnapshot): void {
  const body: PersistedState = { version: 1, history: [...snapshot.history], leases: [...snapshot.leases] };
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function runCheck(argv: string[], log: LogFn, configPath: string | undefined): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      resource: { type: "string" },
      kind: { type: "string" },
      intent: { type: "string" },
      target: { type: "string" },
      at: { type: "string" },
      config: { type: "string", default: configPath },
      store: { type: "string" },
      state: { type: "string" },
    },
    strict: true,
  });
  const config = loadConfig(values["config"]);
  const engine = new CollisionEngine({ now: Date.now, ...config.engine });
  for (const policy of config.policies) engine.registerPolicy(policy);
  const statePath = values["state"];
  if (statePath !== undefined) loadStateFile(engine, statePath);
  const action = actionFromFlags(values);
  const result = engine.record(action);
  log(JSON.stringify(result, null, 2));
  if (statePath !== undefined) {
    writeStateFile(statePath, engine.snapshot());
    log(`state: ${statePath}`);
  }
  const store = values["store"];
  if (store !== undefined) {
    const audit = new AuditLog(store);
    audit.recordCollision(action, result.collisions, result.decision);
    log(`audit: ${audit.size} entr${audit.size === 1 ? "y" : "ies"} in ${store}`);
  }
  return result.decision === "rejected" ? 3 : 0;
}

function runClaim(argv: string[], log: LogFn, configPath: string | undefined): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      resource: { type: "string" },
      agent: { type: "string" },
      mode: { type: "string", default: "exclusive" },
      "ttl-ms": { type: "string" },
      config: { type: "string", default: configPath },
      state: { type: "string" },
    },
    strict: true,
  });
  const config = loadConfig(values["config"]);
  const engine = new CollisionEngine({ now: Date.now, ...config.engine });
  for (const policy of config.policies) engine.registerPolicy(policy);
  const statePath = values["state"];
  if (statePath !== undefined) loadStateFile(engine, statePath);
  const resource = requireValue(values["resource"] as string | undefined, "resource");
  const agent = requireValue(values["agent"] as string | undefined, "agent");
  const mode = requireValue(values["mode"] as string | undefined, "mode");
  if (mode !== "exclusive" && mode !== "shared") {
    throw new DetectorError("VALIDATION", `--mode must be "exclusive" or "shared", got "${mode}"`);
  }
  const ttlMs = numberValue(values["ttl-ms"], "ttl-ms") ?? 300_000;
  const result = engine.locks.acquire(resource, agent, { mode, ttlMs });
  if (result.granted) {
    if (statePath !== undefined) writeStateFile(statePath, engine.snapshot());
    log(JSON.stringify({ granted: true }));
    log(JSON.stringify(result.lease, null, 2));
    return 0;
  }
  log(JSON.stringify({ granted: false }));
  log(JSON.stringify(result.blockedBy, null, 2));
  return 3;
}

function runRelease(argv: string[], log: LogFn, configPath: string | undefined): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      resource: { type: "string" },
      agent: { type: "string" },
      config: { type: "string", default: configPath },
      state: { type: "string" },
    },
    strict: true,
  });
  const config = loadConfig(values["config"]);
  const engine = new CollisionEngine({ now: Date.now, ...config.engine });
  const statePath = values["state"];
  if (statePath !== undefined) loadStateFile(engine, statePath);
  const resource = requireValue(values["resource"] as string | undefined, "resource");
  const agent = requireValue(values["agent"] as string | undefined, "agent");
  const released = engine.locks.release(resource, agent);
  if (released && statePath !== undefined) writeStateFile(statePath, engine.snapshot());
  log(JSON.stringify({ released }));
  if (!released) log(`no live lease on "${resource}" held by ${agent}`);
  return released ? 0 : 1;
}

function runAudit(argv: string[], log: LogFn): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      store: { type: "string" },
      tail: { type: "string", default: "10" },
      verify: { type: "boolean", default: false },
    },
    strict: true,
  });
  const store = requireValue(values["store"] as string | undefined, "store");
  const audit = new AuditLog(store);
  if (values["verify"] === true) {
    const report = audit.verify();
    log(JSON.stringify(report, null, 2));
    return report.intact ? 0 : 1;
  }
  const n = numberValue(values["tail"], "tail") ?? 10;
  const entries = audit.tail(n).map((entry) => ({ ...entry, hash: audit.hashOf(entry) }));
  log(JSON.stringify({ total: audit.size, entries }, null, 2));
  return 0;
}

function runServe(argv: string[], log: LogFn, configPath: string | undefined): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      token: { type: "string" },
      audit: { type: "string" },
      config: { type: "string", default: configPath },
    },
    strict: true,
  });
  void (async () => {
    const { serve } = await import("./server.js");
    const config = loadConfig(values["config"] ?? configPath);
    const tokenFlag = values["token"] as string | undefined;
    const auditFlag = values["audit"] as string | undefined;
    const port = numberValue(values["port"], "port");
    const token = tokenFlag !== undefined ? tokenFlag : config.token;
    const detector = await serve({
      engine: config.engine,
      policies: config.policies,
      ...(port !== undefined ? { port } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(auditFlag !== undefined ? { auditPath: auditFlag } : {}),
    });
    const url = await detector.url;
    log(`agent-collision-detector listening on ${url}`);
    if (token === undefined) {
      log("warning: no bearer token configured; writes are rejected until --token is set");
    }
  })().catch((err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
  return 0;
}

function runHelp(log: LogFn): number {
  log(`agent-collision-detector — detect and resolve conflicts between autonomous agents

Usage: agent-collision-detector <command> [flags]

Commands:
  check   score one agent action against live leases, policies and recent history
  claim   acquire a lease on a resource (alias: lease)
  release drop a lease held by an agent
  audit   tail or verify the hash-chained decision ledger
  serve   run the HTTP detector (GET /healthz /stats /policies /leases /audit)
  demo    print a deterministic transcript of the engine catching real conflicts

Exit codes: 0 clean/accepted, 1 error/not found, 2 lease conflict, 3 action rejected.`);
  return 0;
}

function isMainModule(): boolean {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] !== undefined ? realpathSync(process.argv[1]) : "";
    return invoked === self;
  } catch {
    return false;
  }
}

/** CLI entry point, separated from main() so tests can drive it directly. */
export async function runCli(argv: string[], log: LogFn = (line) => console.log(line)): Promise<number> {
  const [command, ...rest] = argv;
  const configFlagIndex = argv.indexOf("--config");
  const configPath = configFlagIndex >= 0 ? argv[configFlagIndex + 1] : undefined;
  try {
    switch (command) {
      case "check":
        return runCheck(rest, log, configPath);
      case "claim":
      case "lease":
        return runClaim(rest, log, configPath);
      case "release":
        return runRelease(rest, log, configPath);
      case "audit":
        return runAudit(rest, log);
      case "serve":
        return runServe(rest, log, configPath);
      case "demo":
        for (const line of renderDemo(runDemo())) log(line);
        return 0;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        return runHelp(log);
      default:
        log(`unknown command "${String(command)}"`);
        runHelp(log);
        return 1;
    }
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (isMainModule()) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

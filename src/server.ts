import { createServer, type IncomingMessage, type Server } from "node:http";
import { CollisionEngine } from "./engine.js";
import { AuditLog } from "./audit.js";
import { DetectorError } from "./errors.js";
import { constantTimeEqual } from "./hashing.js";
import type { AgentAction, ResourcePolicy } from "./types.js";

export interface EnginePartial {
  readonly duplicateThreshold?: number;
  readonly duplicateWindowMs?: number;
  readonly writeWindowMs?: number;
  readonly defaultLeaseTtlMs?: number;
  readonly maxTtlMs?: number;
  readonly maxHistory?: number;
}

export interface ServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly auditPath?: string;
  readonly engine?: EnginePartial;
  readonly policies?: readonly ResourcePolicy[];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new DetectorError("VALIDATION", "request body exceeds 1MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const ACTION_FIELDS = ["agent", "resource", "kind", "intent", "at"] as const;

function parseAction(raw: unknown): AgentAction {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DetectorError("VALIDATION", "action must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  for (const field of ACTION_FIELDS) {
    if (obj[field] === undefined) {
      throw new DetectorError("VALIDATION", `action is missing required field "${field}"`);
    }
  }
  const kind = obj["kind"];
  if (kind !== "read" && kind !== "write") {
    throw new DetectorError("VALIDATION", `action.kind must be "read" or "write", got ${JSON.stringify(kind)}`);
  }
  for (const field of ["agent", "resource", "intent"] as const) {
    if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
      throw new DetectorError("VALIDATION", `action.${field} must be a non-empty string`);
    }
  }
  const at = obj["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw new DetectorError("VALIDATION", "action.at must be a finite number");
  }
  const target = obj["target"];
  const action: AgentAction = {
    agent: obj["agent"] as string,
    resource: obj["resource"] as string,
    kind,
    intent: obj["intent"] as string,
    at,
  };
  if (typeof target === "string" && target.length > 0) {
    return { ...action, target };
  }
  return action;
}

function parsePolicyBody(raw: unknown): ResourcePolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DetectorError("VALIDATION", "policy must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const resource = obj["resource"];
  const mode = obj["mode"];
  if (typeof resource !== "string" || resource.length === 0) {
    throw new DetectorError("VALIDATION", "policy.resource must be a non-empty string");
  }
  if (mode !== "exclusive" && mode !== "shared") {
    throw new DetectorError("VALIDATION", `policy.mode must be "exclusive" or "shared", got ${JSON.stringify(mode)}`);
  }
  const policy: ResourcePolicy = {
    resource,
    mode,
    ...(typeof obj["rateLimitPerWindow"] === "number" ? { rateLimitPerWindow: obj["rateLimitPerWindow"] } : {}),
    ...(typeof obj["windowMs"] === "number" ? { windowMs: obj["windowMs"] } : {}),
  };
  return policy;
}

export interface DetectorServer {
  readonly server: Server;
  readonly engine: CollisionEngine;
  readonly audit: AuditLog;
  readonly url: Promise<string>;
  readonly close: () => Promise<void>;
}

export function createDetectorServer(options: ServerOptions = {}): DetectorServer {
  const audit = new AuditLog(options.auditPath);
  const engine = new CollisionEngine({ now: Date.now, ...options.engine });
  for (const policy of options.policies ?? []) engine.registerPolicy(policy);
  const token = options.token;

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown): void => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      const writeMethod = req.method === "POST" || req.method === "DELETE";
      if (writeMethod) {
        const header = req.headers.authorization;
        const provided = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
        if (token === undefined || provided === undefined || !constantTimeEqual(provided, token)) {
          send(401, { error: "unauthorized: bearer token required for writes" });
          return;
        }
      }

      if (req.method === "GET" && path === "/healthz") {
        send(200, { ok: true, service: "agent-collision-detector" });
        return;
      }
      if (req.method === "GET" && path === "/stats") {
        send(200, engine.stats());
        return;
      }
      if (req.method === "GET" && path === "/policies") {
        send(200, { policies: engine.policies.list() });
        return;
      }
      if (req.method === "GET" && path === "/leases") {
        const leases: Record<string, unknown> = {};
        for (const resource of engine.locks.resources()) {
          leases[resource] = engine.locks.inspect(resource);
        }
        send(200, { leases });
        return;
      }
      if (req.method === "GET" && path === "/audit") {
        const n = Math.min(Math.max(Number(url.searchParams.get("n") ?? 20) || 20, 1), 500);
        const entries = audit.tail(n).map((entry) => ({ ...entry, hash: audit.hashOf(entry) }));
        const report = audit.verify();
        send(200, { entries, total: audit.size, intact: report.intact, headHash: report.headHash });
        return;
      }

      if (req.method === "POST" && path === "/check") {
        const action = parseAction(JSON.parse(await readBody(req)));
        const result = engine.record(action);
        audit.recordCollision(action, result.collisions, result.decision);
        send(result.decision === "rejected" ? 409 : 200, result);
        return;
      }
      if (req.method === "POST" && path === "/policies") {
        const policy = parsePolicyBody(JSON.parse(await readBody(req)));
        engine.registerPolicy(policy);
        send(201, { registered: policy });
        return;
      }
      if (req.method === "POST" && path === "/leases") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const resource = body["resource"];
        const agent = body["agent"];
        const mode = body["mode"];
        if (typeof resource !== "string" || resource.length === 0) {
          throw new DetectorError("VALIDATION", "lease.resource must be a non-empty string");
        }
        if (typeof agent !== "string" || agent.length === 0) {
          throw new DetectorError("VALIDATION", "lease.agent must be a non-empty string");
        }
        if (mode !== "exclusive" && mode !== "shared") {
          throw new DetectorError("VALIDATION", `lease.mode must be "exclusive" or "shared", got ${JSON.stringify(mode)}`);
        }
        const ttlRaw = body["ttlMs"];
        const ttlMs = typeof ttlRaw === "number" && Number.isFinite(ttlRaw) ? ttlRaw : undefined;
        const result = engine.locks.acquire(resource, agent, { mode, ttlMs: ttlMs ?? 300_000 });
        if (result.granted) send(201, result);
        else send(409, result);
        return;
      }
      if (req.method === "DELETE" && path === "/leases") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const resource = typeof body["resource"] === "string" ? body["resource"] : "";
        const holder = typeof body["holder"] === "string" ? body["holder"] : "";
        const released = engine.locks.release(resource, holder);
        if (!released) {
          send(404, { error: `no live lease on "${resource}" held by "${holder}"` });
          return;
        }
        send(200, { released: true, resource, holder });
        return;
      }

      send(404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      if (err instanceof DetectorError) {
        send(err.httpStatus, { error: err.message, code: err.code });
        return;
      }
      if (err instanceof SyntaxError) {
        send(400, { error: `invalid JSON body: ${err.message}` });
        return;
      }
      send(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const url = new Promise<string>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

  return {
    server,
    engine,
    audit,
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Convenience wrapper: resolves once the server is listening. */
export function serve(options: ServerOptions = {}): Promise<DetectorServer> {
  const detector = createDetectorServer(options);
  return detector.url.then(() => detector);
}

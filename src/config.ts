import { readFileSync } from "node:fs";
import { DetectorError } from "./errors.js";
import type { EnginePartial } from "./server.js";
import type { ResourcePolicy } from "./types.js";

export interface FileConfig {
  policies: ResourcePolicy[];
  engine: EnginePartial;
  token?: string;
  port?: number;
}

const EMPTY: FileConfig = { policies: [], engine: {} };

function asObject(value: unknown, file: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DetectorError("CONFIG", `config file "${file}" must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parsePolicy(value: unknown, file: string): ResourcePolicy {
  const obj = asObject(value, file);
  const resource = obj["resource"];
  const mode = obj["mode"];
  if (typeof resource !== "string" || resource.length === 0) {
    throw new DetectorError("CONFIG", `config policy resource must be a non-empty string (file "${file}")`);
  }
  if (mode !== "exclusive" && mode !== "shared") {
    throw new DetectorError("CONFIG", `config policy mode must be "exclusive" or "shared" (file "${file}")`);
  }
  const limit = obj["rateLimitPerWindow"];
  if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)) {
    throw new DetectorError("CONFIG", `config policy rateLimitPerWindow must be a positive finite number (file "${file}")`);
  }
  const window = obj["windowMs"];
  if (window !== undefined && (typeof window !== "number" || !Number.isFinite(window) || window <= 0)) {
    throw new DetectorError("CONFIG", `config policy windowMs must be a positive finite number (file "${file}")`);
  }
  return {
    resource,
    mode,
    ...(limit !== undefined ? { rateLimitPerWindow: limit } : {}),
    ...(window !== undefined ? { windowMs: window } : {}),
  };
}

function parseEngine(value: unknown, file: string): EnginePartial {
  const obj = asObject(value, file);
  const out: EnginePartial = {};
  const numeric: Array<[keyof EnginePartial & string, string]> = [
    ["duplicateThreshold", "duplicateThreshold"],
    ["duplicateWindowMs", "duplicateWindowMs"],
    ["writeWindowMs", "writeWindowMs"],
    ["defaultLeaseTtlMs", "defaultLeaseTtlMs"],
    ["maxTtlMs", "maxTtlMs"],
    ["maxHistory", "maxHistory"],
  ];
  for (const [key] of numeric) {
    const raw = obj[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new DetectorError("CONFIG", `config engine.${key} must be a non-negative finite number (file "${file}")`);
    }
    (out as Record<string, unknown>)[key] = raw;
  }
  const threshold = out.duplicateThreshold;
  if (threshold !== undefined && (threshold <= 0 || threshold > 1)) {
    throw new DetectorError("CONFIG", `config engine.duplicateThreshold must be in (0, 1] (file "${file}")`);
  }
  return out;
}

/** Load an optional collision-detector config file (JSON). */
export function loadConfig(path?: string): FileConfig {
  if (path === undefined) return { ...EMPTY, policies: [], engine: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new DetectorError("CONFIG", `cannot read config file "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DetectorError("CONFIG", `config file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const obj = asObject(parsed, path);
  const config: FileConfig = { policies: [], engine: {} };
  const policies = obj["policies"];
  if (policies !== undefined) {
    if (!Array.isArray(policies)) {
      throw new DetectorError("CONFIG", `config policies must be an array (file "${path}")`);
    }
    for (const item of policies) config.policies.push(parsePolicy(item, path));
  }
  if (obj["engine"] !== undefined) config.engine = parseEngine(obj["engine"], path);
  if (obj["duplicateThreshold"] !== undefined) {
    if (config.engine.duplicateThreshold === undefined) {
      const v = obj["duplicateThreshold"];
      if (typeof v !== "number" || v <= 0 || v > 1) {
        throw new DetectorError("CONFIG", `config duplicateThreshold must be in (0, 1] (file "${path}")`);
      }
      config.engine = { ...config.engine, duplicateThreshold: v };
    }
  }
  if (obj["token"] !== undefined) {
    if (typeof obj["token"] !== "string") {
      throw new DetectorError("CONFIG", `config token must be a string (file "${path}")`);
    }
    config.token = obj["token"];
  }
  if (obj["port"] !== undefined) {
    const port = obj["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DetectorError("CONFIG", `config port must be an integer in [1, 65535] (file "${path}")`);
    }
    config.port = port;
  }
  return config;
}

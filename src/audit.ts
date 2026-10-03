import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CorruptionError, DetectorError } from "./errors.js";
import type { AgentAction, Collision } from "./types.js";

export interface AuditEntry {
  readonly seq: number;
  readonly prevHash: string;
  readonly at: number;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

export interface AuditReport {
  readonly intact: boolean;
  readonly entries: number;
  readonly headHash: string;
}

const GENESIS_HASH = "0".repeat(64);

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const canonical = (value: unknown): string => JSON.stringify(sortDeep(value));

function hashEntry(prevHash: string, at: number, kind: string, data: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${prevHash}|${at}|${kind}|${canonical(data)}`)
    .digest("hex");
}

/**
 * Append-only, hash-chained ledger of collision decisions. Survives torn
 * tails (a crash mid-append leaves one unparseable final line that is
 * ignored) and refuses mid-file tampering with a CorruptionError. Writes are
 * atomic: the ledger is rewritten to a temp file and renamed into place.
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private lastHash = GENESIS_HASH;
  private readonly filePath: string | undefined;
  private readonly clock: () => number;

  constructor(filePath?: string, clock: () => number = Date.now) {
    this.filePath = filePath;
    this.clock = clock;
    if (filePath !== undefined) {
      mkdirSync(dirname(filePath), { recursive: true });
      this.load(filePath);
    }
  }

  private load(filePath: string): void {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
      } catch {
        if (i === lines.length - 1) break;
        throw new CorruptionError(`malformed ledger line ${i + 1}`);
      }
      const entry: AuditEntry = {
        seq: Number(parsed["seq"]),
        prevHash: String(parsed["prevHash"]),
        at: Number(parsed["at"]),
        kind: String(parsed["kind"]),
        data: (parsed["data"] ?? {}) as Record<string, unknown>,
      };
      if (entry.seq !== i) {
        throw new CorruptionError(`ledger sequence break at ${i}: expected ${i}, found ${entry.seq}`);
      }
      if (entry.prevHash !== this.lastHash) {
        throw new CorruptionError(`ledger hash chain broken at entry ${i}`);
      }
      const expected = hashEntry(this.lastHash, entry.at, entry.kind, entry.data);
      if (expected !== String(parsed["hash"])) {
        throw new CorruptionError(`ledger entry ${i} failed hash verification`);
      }
      this.lastHash = expected;
      this.entries.push(entry);
    }
  }

  private persist(): void {
    if (this.filePath === undefined) return;
    const body =
      this.entries.map((entry) => JSON.stringify({ ...entry, hash: this.hashOf(entry) })).join("\n") + "\n";
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, this.filePath);
  }

  hashOf(entry: AuditEntry): string {
    return hashEntry(entry.prevHash, entry.at, entry.kind, entry.data);
  }

  append(kind: string, data: Record<string, unknown>): AuditEntry {
    if (kind.length === 0) {
      throw new DetectorError("VALIDATION", "audit kind must be non-empty");
    }
    const entry: AuditEntry = {
      seq: this.entries.length,
      prevHash: this.lastHash,
      at: this.clock(),
      kind,
      data,
    };
    this.lastHash = hashEntry(entry.prevHash, entry.at, entry.kind, entry.data);
    this.entries.push(entry);
    this.persist();
    return entry;
  }

  recordCollision(action: AgentAction, collisions: Collision[], decision: string): AuditEntry {
    return this.append("collision-check", {
      agent: action.agent,
      resource: action.resource,
      intent: action.intent,
      decision,
      collisions: collisions.map((collision) => ({ kind: collision.kind, severity: collision.severity })),
    });
  }

  verify(): AuditReport {
    let hash = GENESIS_HASH;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.seq !== i || entry.prevHash !== hash) {
        throw new CorruptionError(`in-memory ledger broken at ${i}`);
      }
      hash = hashEntry(hash, entry.at, entry.kind, entry.data);
    }
    return { intact: true, entries: this.entries.length, headHash: hash };
  }

  tail(n: number): AuditEntry[] {
    if (n <= 0) return [];
    return this.entries.slice(-n);
  }

  get size(): number {
    return this.entries.length;
  }
}

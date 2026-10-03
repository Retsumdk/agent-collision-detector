import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit.js";
import { CorruptionError } from "../src/errors.js";

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "acd-audit-")), "audit.jsonl");
}

describe("AuditLog", () => {
  test("append, verify, tail and size track the chain", () => {
    const log = new AuditLog();
    log.append("genesis", { note: "start" });
    log.append("collision-check", { agent: "a" });
    log.recordCollision(
      { agent: "a", resource: "r", kind: "write", intent: "do it", at: 1 },
      [{ kind: "write-write", severity: "critical", message: "m", agents: ["a"], resource: "r", evidence: {}, recommended: "queue" }],
      "accepted",
    );
    expect(log.size).toBe(3);
    expect(log.verify()).toEqual({ intact: true, entries: 3, headHash: expect.any(String) });
    expect(log.tail(2)).toHaveLength(2);
    expect(log.tail(0)).toEqual([]);
  });

  test("the ledger persists, reloads and still verifies", () => {
    const path = tempLedger();
    const first = new AuditLog(path);
    first.append("one", { n: 1 });
    first.append("two", { n: 2 });
    const second = new AuditLog(path);
    expect(second.size).toBe(2);
    expect(second.verify().intact).toBe(true);
    expect(second.tail(1)[0]?.data).toEqual({ n: 2 });
    rmSync(path, { force: true });
  });

  test("a torn final line is tolerated", () => {
    const path = tempLedger();
    const log = new AuditLog(path);
    log.append("one", { n: 1 });
    writeFileSync(path, readFileSync(path, "utf8") + '{"seq":1,"prevHa', "utf8");
    const reloaded = new AuditLog(path);
    expect(reloaded.size).toBe(1);
    rmSync(path, { force: true });
  });

  test("mid-file tampering is refused with CorruptionError", () => {
    const path = tempLedger();
    const log = new AuditLog(path);
    log.append("one", { n: 1 });
    log.append("two", { n: 2 });
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    lines[0] = lines[0]!.replace('"n":1', '"n":999');
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
    expect(() => new AuditLog(path)).toThrow(CorruptionError);
    rmSync(path, { force: true });
  });

  test("tampering with the hash chain is refused", () => {
    const path = tempLedger();
    const log = new AuditLog(path);
    log.append("one", { n: 1 });
    log.append("two", { n: 2 });
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    lines[1] = lines[1]!.replace('"seq":1', '"seq":7');
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
    expect(() => new AuditLog(path)).toThrow(/sequence break|hash chain/);
    rmSync(path, { force: true });
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { renderDemo, runDemo } from "../src/demo.js";

function buffer() {
  const lines: string[] = [];
  return { lines, log: (line: string): void => { lines.push(line); } };
}

function tempStore(): string {
  return join(mkdtempSync(join(tmpdir(), "acd-cli-")), "audit.jsonl");
}

function tempState(): string {
  return join(mkdtempSync(join(tmpdir(), "acd-state-")), "state.json");
}

function tempConfigFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "acd-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

describe("runCli", () => {
  test("check reports a clean first action and writes to the audit store", async () => {
    const store = tempStore();
    const out = buffer();
    const code = await runCli(
      ["check", "--agent", "scanner", "--resource", "kb://home", "--kind", "write", "--intent", "rebuild the home page", "--at", "1000", "--store", store],
      out.log,
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.lines[0]!) as { decision: string; collisions: unknown[] };
    expect(result.decision).toBe("accepted");
    expect(result.collisions).toEqual([]);
    const auditOut = buffer();
    await runCli(["audit", "--store", store, "--tail", "5"], auditOut.log);
    const audit = JSON.parse(auditOut.lines[0]!) as { total: number; entries: unknown[] };
    expect(audit.total).toBe(1);
    expect(audit.entries).toHaveLength(1);
    rmSync(store, { force: true });
  });

  test("lease, conflict and release round-trip through the CLI", async () => {
    const out = buffer();
    const state = tempState();
    const granted = await runCli(["lease", "--resource", "db://orders", "--agent", "a", "--mode", "exclusive", "--ttl-ms", "60000", "--state", state], out.log);
    expect(granted).toBe(0);
    const grantedBody = JSON.parse(out.lines[0]!) as { granted: boolean };
    expect(grantedBody.granted).toBe(true);

    const blocked = buffer();
    const blockedCode = await runCli(["lease", "--resource", "db://orders", "--agent", "b", "--mode", "shared", "--ttl-ms", "60000", "--state", state], blocked.log);
    expect(blockedCode).toBe(3);
    const blockedBody = JSON.parse(blocked.lines[0]!) as { granted: boolean };
    expect(blockedBody.granted).toBe(false);

    const released = buffer();
    const releasedCode = await runCli(["release", "--resource", "db://orders", "--agent", "a", "--state", state], released.log);
    expect(releasedCode).toBe(0);
    expect(released.lines.join("\n")).toContain("released");
  });

  test("audit --verify reports an intact ledger", async () => {
    const store = tempStore();
    const out = buffer();
    await runCli(["check", "--agent", "a", "--resource", "r", "--kind", "read", "--intent", "look", "--at", "1", "--store", store], out.log);
    const verified = buffer();
    const code = await runCli(["audit", "--store", store, "--verify"], verified.log);
    expect(code).toBe(0);
    const report = JSON.parse(verified.lines[0]!) as { intact: boolean; entries: number };
    expect(report.intact).toBe(true);
    expect(report.entries).toBe(1);
    rmSync(store, { force: true });
  });

  test("a rejected check exits 3 with the collision in the JSON", async () => {
    const out = buffer();
    const state = tempState();
    const config = tempConfigFile({ policies: [{ resource: "r", mode: "shared", rateLimitPerWindow: 1 }] });
    const base = ["check", "--agent", "a", "--resource", "r", "--kind", "write", "--intent", "first", "--at", "1", "--state", state, "--config", config];
    const second = ["check", "--agent", "b", "--resource", "r", "--kind", "write", "--intent", "second", "--at", "2", "--state", state, "--config", config];
    await runCli(base, out.log);
    const rejected = buffer();
    const code = await runCli(second, rejected.log);
    expect(code).toBe(3);
    const body = JSON.parse(rejected.lines[0]!) as { decision: string; collisions: Array<{ kind: string }> };
    expect(body.decision).toBe("rejected");
    expect(body.collisions.map((c) => c.kind)).toContain("rate-limit");
  });

  test("demo prints a deterministic transcript", async () => {
    const out = buffer();
    const code = await runCli(["demo"], out.log);
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toContain("write-write");
    expect(out.lines.join("\n")).toContain("rate-limit");
    expect(out.lines.join("\n")).toContain("duplicate-work");
  });

  test("demo render matches runDemo exactly across invocations", () => {
    expect(renderDemo(runDemo()).join("\n")).toBe(renderDemo(runDemo()).join("\n"));
  });

  test("help exits 0 with usage", async () => {
    const out = buffer();
    expect(await runCli(["help"], out.log)).toBe(0);
    expect(out.lines.join("\n")).toContain("Usage:");
  });

  test("an unknown command fails with a usage hint", async () => {
    const out = buffer();
    const code = await runCli(["frobnicate"], out.log);
    expect(code).toBe(1);
    expect(out.lines.join("\n")).toContain("unknown command");
  });

  test("check validates its flags", async () => {
    const out = buffer();
    const code = await runCli(["check", "--agent", "a", "--resource", "r", "--kind", "append", "--intent", "x", "--at", "1"], out.log);
    expect(code).toBe(1);
    expect(out.lines.join("\n")).toContain("--kind");
  });
});

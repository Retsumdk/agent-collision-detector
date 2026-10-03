import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DetectorError } from "../src/errors.js";

function tempConfig(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "acd-cfg-")), "config.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function cleanup(path: string): void {
  rmSync(path, { force: true });
}

describe("loadConfig", () => {
  test("no path yields defaults", () => {
    expect(loadConfig()).toEqual({ policies: [], engine: {} });
  });

  test("a full config parses with validated policies", () => {
    const path = tempConfig({
      policies: [{ resource: "db://orders", mode: "shared", rateLimitPerWindow: 5, windowMs: 30_000 }],
      engine: { duplicateThreshold: 0.8, duplicateWindowMs: 1000, writeWindowMs: 2000, defaultLeaseTtlMs: 3000, maxTtlMs: 4000 },
      token: "t",
      port: 8080,
    });
    const config = loadConfig(path);
    expect(config.policies).toEqual([{ resource: "db://orders", mode: "shared", rateLimitPerWindow: 5, windowMs: 30_000 }]);
    expect(config.engine.duplicateThreshold).toBe(0.8);
    expect(config.engine.duplicateWindowMs).toBe(1000);
    expect(config.engine.writeWindowMs).toBe(2000);
    expect(config.engine.defaultLeaseTtlMs).toBe(3000);
    expect(config.engine.maxTtlMs).toBe(4000);
    expect(config.token).toBe("t");
    expect(config.port).toBe(8080);
    cleanup(path);
  });

  test("a legacy top-level duplicateThreshold maps into engine options", () => {
    const path = tempConfig({ duplicateThreshold: 0.75 });
    const config = loadConfig(path);
    expect(config.engine.duplicateThreshold).toBe(0.75);
    cleanup(path);
  });

  test("invalid JSON is a CONFIG error", () => {
    const path = join(mkdtempSync(join(tmpdir(), "acd-cfg-")), "config.json");
    writeFileSync(path, "{nope", "utf8");
    expect(() => loadConfig(path)).toThrow(DetectorError);
    cleanup(path);
  });

  test("a missing file is a CONFIG error", () => {
    expect(() => loadConfig("/nonexistent/config.json")).toThrow(DetectorError);
  });

  test("each field is validated", () => {
    const badThreshold = tempConfig({ duplicateThreshold: 1.5 });
    expect(() => loadConfig(badThreshold)).toThrow(/duplicateThreshold/);
    cleanup(badThreshold);

    const badPort = tempConfig({ port: 99_999 });
    expect(() => loadConfig(badPort)).toThrow(/port/);
    cleanup(badPort);

    const badPolicy = tempConfig({ policies: [{ resource: "r", mode: "free-for-all" }] });
    expect(() => loadConfig(badPolicy)).toThrow(/mode/);
    cleanup(badPolicy);

    const badRate = tempConfig({ policies: [{ resource: "r", mode: "shared", rateLimitPerWindow: 0 }] });
    expect(() => loadConfig(badRate)).toThrow(/rateLimitPerWindow/);
    cleanup(badRate);

    const badToken = tempConfig({ token: 42 });
    expect(() => loadConfig(badToken)).toThrow(/token/);
    cleanup(badToken);
  });
});

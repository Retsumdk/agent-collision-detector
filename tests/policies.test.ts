import { describe, expect, test } from "bun:test";
import { PolicyTable } from "../src/policies.js";
import { DetectorError } from "../src/errors.js";

describe("PolicyTable", () => {
  test("register, lookup and sorted list", () => {
    const table = new PolicyTable();
    table.register({ resource: "b://x", mode: "shared" });
    table.register({ resource: "a://y", mode: "exclusive", rateLimitPerWindow: 5, windowMs: 1_000 });
    expect(table.lookup("a://y")?.rateLimitPerWindow).toBe(5);
    expect(table.list().map((p) => p.resource)).toEqual(["a://y", "b://x"]);
    expect(table.lookup("missing")).toBeUndefined();
  });

  test("registering the same resource replaces the policy", () => {
    const table = new PolicyTable();
    table.register({ resource: "r", mode: "exclusive" });
    table.register({ resource: "r", mode: "shared" });
    expect(table.lookup("r")?.mode).toBe("shared");
  });

  test("validation rejects bad modes and non-positive limits", () => {
    const table = new PolicyTable();
    expect(() => table.register({ resource: "r", mode: "chaos" as "shared" })).toThrow(DetectorError);
    expect(() => table.register({ resource: "r", mode: "shared", rateLimitPerWindow: 0 })).toThrow(DetectorError);
    expect(() => table.register({ resource: "r", mode: "shared", windowMs: -5 })).toThrow(DetectorError);
    expect(() => table.register({ resource: "", mode: "shared" })).toThrow(DetectorError);
  });
});

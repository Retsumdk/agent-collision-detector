import { describe, test, expect } from "bun:test";
describe("agent-collision-detector", () => {
  test("module loads", async () => { const m = await import('../src/index'); expect(m).toBeDefined(); });
});

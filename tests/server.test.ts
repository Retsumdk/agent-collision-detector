import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetectorServer } from "../src/server.js";

const TOKEN = "secret-token";

async function jsonFetch(url: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}${path}`, init);
  return { status: res.status, body: await res.json() };
}

function auth(token?: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  };
}

describe("detector HTTP server", () => {
  test("healthz, stats and the full write flow with bearer auth", async () => {
    const auditPath = join(mkdtempSync(join(tmpdir(), "acd-srv-")), "audit.jsonl");
    const detector = createDetectorServer({ token: TOKEN, auditPath });
    const url = await detector.url;
    try {
      const health = await jsonFetch(url, "/healthz");
      expect(health.status).toBe(200);
      expect(health.body.service).toBe("agent-collision-detector");

      const noAuth = await jsonFetch(url, "/check", { ...auth(), body: JSON.stringify({}) });
      expect(noAuth.status).toBe(401);
      const badAuth = await jsonFetch(url, "/check", { ...auth("wrong"), body: JSON.stringify({}) });
      expect(badAuth.status).toBe(401);

      const first = await jsonFetch(url, "/check", {
        ...auth(TOKEN),
        body: JSON.stringify({ agent: "scanner", resource: "kb://home", kind: "write", intent: "rebuild the home page", target: "home", at: 1 }),
      });
      expect(first.status).toBe(200);
      expect(first.body.decision).toBe("accepted");
      expect(first.body.collisions).toEqual([]);

      const second = await jsonFetch(url, "/check", {
        ...auth(TOKEN),
        body: JSON.stringify({ agent: "writer", resource: "kb://home", kind: "write", intent: "restyle the home page", target: "home", at: 2 }),
      });
      expect(second.status).toBe(200);
      const kinds: string[] = second.body.collisions.map((c: { kind: string }) => c.kind);
      expect(kinds).toContain("resource-contention");
      expect(kinds).toContain("write-write");
      expect(second.body.plan.strategy).toBe("queue");

      const stats = await jsonFetch(url, "/stats");
      expect(stats.body.actionsRecorded).toBe(2);
      expect(stats.body.collisionsEmitted).toBeGreaterThan(0);

      const audit = await jsonFetch(url, "/audit?n=10");
      expect(audit.body.total).toBe(2);
      expect(audit.body.intact).toBe(true);
      expect(audit.body.entries[0].hash).toMatch(/^[0-9a-f]{64}$/);

      const badJson = await jsonFetch(url, "/check", { ...auth(TOKEN), body: "not json" });
      expect(badJson.status).toBe(400);
      const badAction = await jsonFetch(url, "/check", { ...auth(TOKEN), body: JSON.stringify({ agent: "a" }) });
      expect(badAction.status).toBe(400);
    } finally {
      await detector.close();
      rmSync(auditPath, { force: true });
    }
  });

  test("policies, leases and rate-limit rejection over HTTP", async () => {
    const detector = createDetectorServer({ token: TOKEN });
    const url = await detector.url;
    try {
      const policy = await jsonFetch(url, "/policies", {
        ...auth(TOKEN),
        body: JSON.stringify({ resource: "api://search", mode: "shared", rateLimitPerWindow: 2, windowMs: 60_000 }),
      });
      expect(policy.status).toBe(201);
      expect(policy.body.registered.rateLimitPerWindow).toBe(2);

      const listed = await jsonFetch(url, "/policies");
      expect(listed.body.policies).toHaveLength(1);

      const action = { agent: "x", resource: "api://search", kind: "read", intent: "search", at: 0 };
      expect((await jsonFetch(url, "/check", { ...auth(TOKEN), body: JSON.stringify({ ...action, at: 1_000 }) })).status).toBe(200);
      expect((await jsonFetch(url, "/check", { ...auth(TOKEN), body: JSON.stringify({ ...action, at: 2_000 }) })).status).toBe(200);
      const third = await jsonFetch(url, "/check", { ...auth(TOKEN), body: JSON.stringify({ ...action, at: 3_000 }) });
      expect(third.status).toBe(409);
      expect(third.body.collisions[0].kind).toBe("rate-limit");

      const grant = await jsonFetch(url, "/leases", { ...auth(TOKEN), body: JSON.stringify({ resource: "db://orders", agent: "a", mode: "exclusive", ttlMs: 5_000 }) });
      expect(grant.status).toBe(201);
      expect(grant.body.granted).toBe(true);

      const conflict = await jsonFetch(url, "/leases", { ...auth(TOKEN), body: JSON.stringify({ resource: "db://orders", agent: "b", mode: "shared", ttlMs: 5_000 }) });
      expect(conflict.status).toBe(409);
      expect(conflict.body.granted).toBe(false);

      const leases = await jsonFetch(url, "/leases");
      expect(leases.body.leases["db://orders"]).toHaveLength(1);

      const released = await jsonFetch(url, "/leases", { method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ resource: "db://orders", holder: "a" }) });
      expect(released.status).toBe(200);

      const missing = await jsonFetch(url, "/leases", { method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ resource: "db://orders", holder: "a" }) });
      expect(missing.status).toBe(404);

      const noRoute = await jsonFetch(url, "/nope");
      expect(noRoute.status).toBe(404);
    } finally {
      await detector.close();
    }
  });
});

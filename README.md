# agent-collision-detector

Detects and resolves conflicts between autonomous agents **before** they mutate shared state. One engine, one call: `engine.record(action)` → a decision (`accepted` / `rejected`), the collisions it found, and a concrete resolution plan.

## The problem

Multi-agent systems fail quietly. Two agents write the same entity at the same moment and the second write silently clobbers the first. Two agents independently decide to do the same task and you pay for both. One agent hammers a shared resource and every other agent's work degrades. None of these throw exceptions — they just corrupt data and burn tokens until a human notices.

Coordination today is either manual (hope your prompts don't overlap) or heavyweight (a full workflow orchestrator, a queue, a lock service). If your agents already run as independent processes with their own schedules — cron agents, background workers, distributed crawlers — there has been no small, honest layer that answers one question per action: *is this safe to do right now, and if not, what should the agent do instead?*

## The solution

`agent-collision-detector` is a deterministic, dependency-free (Node built-ins only) decision engine:

- **One call per action.** An agent reports `{agent, kind: read|write, resource, intent, target?, at}` before acting. The engine replies with a decision, every collision it detected, and a plan.
- **Advisory by default, strict on rate limits.** Contention, races and duplicate work are reported so the caller can decide; a policy rate-limit breach is a hard rejection.
- **Leases with TTLs.** Agents can hold exclusive/shared leases so conflicts are visible even to agents that arrive later.
- **Near-duplicate intent detection.** 64-bit SimHash over the intent text catches "rewrite the hero section" vs "update the hero section" without an embedding model.
- **A tamper-evident ledger.** Every decision is appended to a hash-chained audit log; `verify()` walks the chain and rejects mid-file tampering.

## How it works

```
action ──► record() ──► detectors ──► decision + collisions ──► resolution plan
                          │                 │
                          │                 └─► audit ledger (hash-chained append)
                          └─► lock registry (exclusive/shared leases, TTL sweep)
```

### Collision kinds

| Kind | Trigger | Severity | Recommended strategy |
|---|---|---|---|
| `write-write` | two write intents on the same `target` within `writeWindowMs` (default 10 min) | `critical` | `queue` — serialize writers |
| `resource-contention` | resource held under an exclusive policy by another agent | `high` | `queue` — grant in arrival order |
| `duplicate-work` | SimHash similarity ≥ `duplicateThreshold` (default 0.9) between two agents' intents in `duplicateWindowMs` (default 30 min) | `medium` | `merge` — the later agent subscribes to the first |
| `rate-limit` | a policy's `rateLimitPerWindow` exceeded within its `windowMs` | `medium` | `shift` — defer by the window; **rejected** |
| `read-write` | a read against an entity with a pending write in `writeWindowMs` | `high` | `shift` — order reads before the write |

Plans are deterministic: the same history always yields the same plan, so decisions replay cleanly in tests.

### Leases

`LockRegistry` grants exclusive/shared leases with TTLs. Shared leases coexist; an exclusive lease blocks everyone (the sole holder can upgrade freely). `LeaseRegistry` is the stricter variant used when you want acquire to *throw* on conflict instead of returning a soft result — useful for claim-style workflows.

### Audit ledger

`AuditLog` is an append-only, hash-chained JSONL ledger. Each entry carries `seq`, `prevHash`, and `hash` (SHA-256 over the canonical entry). A torn final line (crash mid-append) is tolerated; any modified earlier entry breaks the chain and `verify()` reports it.

## Getting started

Requires Node ≥ 20 (Bun ≥ 1.2 also works for development).

```bash
git clone https://github.com/Retsumdk/agent-collision-detector
cd agent-collision-detector
bun install        # runs `tsc` via the prepare script and builds dist/
bun test           # 67 tests
bun src/cli.ts demo
```

Or install straight from GitHub:

```bash
npm install github:Retsumdk/agent-collision-detector
```

(`prepare: tsc` runs on install, so the package builds itself. Bun users: run `bun pm trust agent-collision-detector` after adding it — Bun blocks git-dependency lifecycle scripts by default.)

## The demo

```bash
bun src/cli.ts demo
```

```text
[t=0 scanner write kb://pages/home] accepted — no collisions
[t=2000 writer write kb://pages/home] accepted — resource-contention (high), write-write (critical); plan: queue — writer order: scanner -> writer
[t=4000 scout read kb://pages/home] accepted — resource-contention (high), duplicate-work (medium); plan: queue — grant order: scanner@0 -> scout@4000
[t=6000 reader read api://search] accepted — no collisions
[t=8000 reader read api://search] accepted — no collisions
[t=10000 reader read api://search] rejected — rate-limit (medium); plan: shift — defer reader by 60000ms; reason: policy for api://search allows 2 actions per 60000ms; 2 already recorded
[audit] {"intact":true,"entries":6,"headHash":"8dd69a7798631f706c3ed297408b8f6a5a8d2aa357e60a731e2b0a552e877975"}
[stats] {"actionsRecorded":5,"collisionsEmitted":5,"liveResources":["api://search","kb://pages/home"]}
```

The transcript is fully deterministic (fixed clock), so it doubles as a golden test.

## Library usage

```ts
import { CollisionEngine, AuditLog } from "agent-collision-detector";

const audit = new AuditLog("./decisions.jsonl");
const engine = new CollisionEngine({ now: () => Date.now() });

engine.registerPolicy({ resource: "api://search", mode: "shared", rateLimitPerWindow: 2 });

const result = engine.record({
  agent: "writer-1",
  kind: "write",
  resource: "kb://pages/home",
  intent: "update the hero section",
  target: "hero",
  at: Date.now(),
});

if (result.decision === "rejected") {
  console.log(result.reason);
} else if (result.collisions.length > 0) {
  for (const c of result.collisions) console.log(c.kind, c.severity, c.recommended);
  console.log(result.plan?.strategy, result.plan?.detail); // e.g. queue "grant order: ..."
}

audit.recordCollision(action, result.collisions, result.decision);
```

Leases:

```ts
const claim = engine.locks.acquire("db://orders", "migrator", { mode: "exclusive", ttlMs: 60_000 });
if (!claim.granted) console.log("blocked by", claim.blockedBy);
engine.locks.release("db://orders", "migrator");
```

## CLI

```text
Usage: agent-collision-detector <command> [flags]

Commands:
  check   score one agent action against live leases, policies and recent history
  claim   acquire a lease on a resource (alias: lease)
  release drop a lease held by an agent
  audit   tail or verify the hash-chained decision ledger
  serve   run the HTTP detector (GET /healthz /stats /policies /leases /audit)
  demo    print a deterministic transcript of the engine catching real conflicts

Exit codes: 0 clean/accepted, 1 error/not found, 2 lease conflict, 3 action rejected.
```

`check`, `claim` and `release` accept `--state <file>` to persist engine history and live leases between invocations (atomic JSON writes via temp-file rename) — this is how separate CLI processes coordinate:

```bash
bun src/cli.ts check --agent a --resource r --kind write --intent "first" --at 1 --state ./acd-state.json
bun src/cli.ts check --agent b --resource r --kind write --intent "second" --at 2 --state ./acd-state.json   # exits 3 if rejected
bun src/cli.ts lease --resource db://orders --agent migrator --mode exclusive --ttl-ms 60000 --state ./acd-state.json
bun src/cli.ts release --resource db://orders --agent migrator --state ./acd-state.json
bun src/cli.ts audit --store ./decisions.jsonl --verify
```

`--config <file>` loads a JSON file of the shape:

```json
{
  "engine": { "duplicateThreshold": 0.85 },
  "policies": [{ "resource": "api://search", "mode": "shared", "rateLimitPerWindow": 2 }],
  "token": "secret",
  "port": 8080
}
```

## HTTP API

```bash
agent-collision-detector serve --port 8080 --token secret --audit ./decisions.jsonl
```

Writes (`POST`) require `Authorization: Bearer <token>`; reads are open.

| Route | Method | Body | Notes |
|---|---|---|---|
| `/healthz` | GET | — | liveness |
| `/stats` | GET | — | engine counters + live resources |
| `/policies` | GET | — | registered policies |
| `/policies` | POST | `ResourcePolicy` | register a policy (201) |
| `/leases` | GET | — | live leases by resource |
| `/leases` | POST | `{resource, agent, mode, ttlMs?}` | acquire (201) or blocked (409) |
| `/leases` | DELETE | `{resource, holder}` | release (200) or 404 |
| `/check` | POST | `AgentAction` | decision (200) or rejection (409) |
| `/audit?n=20` | GET | — | last n ledger entries + `verify()` report |

Examples with real responses:

```bash
$ curl -s localhost:8080/healthz
{"ok":true,"service":"agent-collision-detector"}

$ curl -s -X POST localhost:8080/check \
    -H 'authorization: Bearer secret' -H 'content-type: application/json' \
    -d '{"agent":"writer","kind":"write","resource":"kb://pages/home","intent":"rewrite the hero section","target":"hero","at":2}'
{"decision":"accepted","collisions":[{"kind":"resource-contention","severity":"high","message":"kb://pages/home is held by scanner under exclusive policy","agents":["scanner","writer"],"resource":"kb://pages/home","evidence":{"holders":"scanner (exclusive, expires 1791059518315)","requestedMode":"exclusive"},"recommended":"queue"}],"plan":{"strategy":"queue","rationale":"Exclusive resource already held; serialize the claimants.","detail":"grant order: scanner@1 -> writer@2"}}

$ curl -s -X POST localhost:8080/check -H 'content-type: application/json' -d '{"agent":"x","kind":"read","resource":"r","intent":"i","at":3}'
{"error":"unauthorized: bearer token required for writes"}    # HTTP 401
```

Contention is advisory — the response carries the collision and plan with HTTP 200; only rate-limit breaches return 409.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess)
bun test
bun run build       # emits dist/ with declarations
```

## License

[MIT](./LICENSE)

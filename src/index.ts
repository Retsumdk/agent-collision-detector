export { CollisionEngine, type EngineOptions, type RecordResult } from "./engine.js";
export { resolveCollision, type ResolutionPlan } from "./resolution.js";
export { PolicyTable } from "./policies.js";
export { LockRegistry, type LockOptions, type LockMode, type AcquireResult, type Lease } from "./lock.js";
export { LeaseRegistry, type LeaseOptions } from "./lease.js";
export { AuditLog, type AuditEntry, type AuditReport } from "./audit.js";
export { runDemo, renderDemo, type DemoRun, type DemoLine } from "./demo.js";
export { loadConfig, type FileConfig } from "./config.js";
export { createDetectorServer, type ServerOptions, type DetectorServer } from "./server.js";
export { simhash, simhashSimilarity } from "./simhash.js";
export { hash64, hamming64Bits, sha256Hex, constantTimeEqual } from "./hashing.js";
export { DetectorError, CorruptionError, type ErrorCode } from "./errors.js";
export type {
  AgentAction,
  ActionKind,
  Claim,
  AccessMode,
  Collision,
  CollisionKind,
  ResolutionStrategy,
  ResourcePolicy,
  EngineStats,
} from "./types.js";

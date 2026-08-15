import { Type, type Static } from "typebox";
import { AcceptedRunPolicySchema, AgentInvocationSchema } from "./accepted-run-policy.js";
import { ConcurrencyLimitsSchema } from "./scheduling.js";

export const DEFAULT_RETENTION_MS = 10 * 60_000;
export const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 15_000;
export const DEFAULT_CONCURRENCY_LIMIT = 4;
/**
 * Turns a subagent may still use after the soft turn limit to wrap up.
 *
 * Owned here with the other runtime defaults because both the settings
 * fragment that persists an override and the session adapter that enforces the
 * limit need the same number; a second copy in either place would drift.
 */
export const DEFAULT_GRACE_TURNS = 6;

export const AgentStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("turn_limited"),
  Type.Literal("aborted"),
  Type.Literal("stopped"),
  Type.Literal("error"),
]);

export const StopInitiatorSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("agent"),
]);

export const DebugFaultKindSchema = Type.Union([
  Type.Literal("output_blocked"),
  Type.Literal("provider_error"),
]);

export const LifetimeUsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheWrite: Type.Number(),
  cost: Type.Number(),
}, { additionalProperties: false });

export const AgentStatsSchema = Type.Object({
  lifetimeUsage: LifetimeUsageSchema,
  toolUses: Type.Integer({ minimum: 0 }),
  turnCount: Type.Optional(Type.Integer({ minimum: 0 })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  compactionCount: Type.Integer({ minimum: 0 }),
  contextPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
}, { additionalProperties: false });

export const AgentSnapshotSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  type: Type.String({ minLength: 1 }),
  description: Type.String(),
  status: AgentStatusSchema,
  startedAt: Type.Integer(),
  completedAt: Type.Optional(Type.Integer()),
  stoppedBy: Type.Optional(StopInitiatorSchema),
  pinnedAt: Type.Optional(Type.Integer()),
  cleanupExpiryPausedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  resultPersisted: Type.Optional(Type.Boolean()),
  resultConsumed: Type.Optional(Type.Boolean()),
  invocation: Type.Optional(AgentInvocationSchema),
  acceptedPolicy: AcceptedRunPolicySchema,
  concurrencyKey: Type.String({ minLength: 1 }),
  result: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  settled: Type.Boolean(),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  liveSession: Type.Boolean(),
  resultSessionId: Type.Optional(Type.String()),
  resultOriginEntryId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resultDeliveryId: Type.Optional(Type.String()),
  debugFaultKind: Type.Optional(DebugFaultKindSchema),
  graceTurns: Type.Optional(Type.Integer({ minimum: 0 })),
  stats: AgentStatsSchema,
  worktreePath: Type.Optional(Type.String()),
}, { additionalProperties: false });

/**
 * List ticks never read the accepted call. Checking that catalog on every
 * refresh was the hitch; stubbing it and hanging the live object back was
 * the hole. A row without the policy is the gate the list can actually pay
 * for. Revisit if a list consumer starts needing the accepted call.
 */
export const AgentListSnapshotSchema = Type.Omit(
  AgentSnapshotSchema,
  ["acceptedPolicy"],
  { additionalProperties: false },
);

const JsonValueSchema = Type.Cyclic({
  JsonValue: Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Type.Ref("JsonValue")),
    Type.Record(Type.String(), Type.Ref("JsonValue")),
  ]),
}, "JsonValue");

export const SpawnCommandSchema = Type.Object({
  kind: Type.Literal("spawn"),
  type: Type.String({ minLength: 1 }),
  prompt: Type.String(),
  description: Type.String(),
  acceptedPolicy: AcceptedRunPolicySchema,
  /**
   * The tool's resolved worktree snapshot. Discovery needs the same trusted
   * path before spawn, so lifecycle consumes that decision instead of probing
   * the repository a second time. The raw path and parent cwd are deliberately
   * absent; additionalProperties prevents that split authority from returning.
   */
  validatedWorktreePath: Type.Optional(Type.String()),
  invocation: Type.Optional(AgentInvocationSchema),
  resultSessionId: Type.Optional(Type.String()),
  resultOriginEntryId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  parentAborted: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const StopCommandSchema = Type.Object({
  kind: Type.Literal("stop"),
  id: Type.String({ minLength: 1 }),
  initiator: Type.Optional(StopInitiatorSchema),
}, { additionalProperties: false });

export const InteractCommandSchema = Type.Object({
  kind: Type.Literal("interact"),
  id: Type.String({ minLength: 1 }),
  message: Type.String(),
  images: Type.Optional(Type.Array(JsonValueSchema)),
}, { additionalProperties: false });

export const InspectCommandSchema = Type.Object({
  kind: Type.Literal("inspect"),
  id: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const PinCommandSchema = Type.Object({
  kind: Type.Literal("pin"),
  id: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const ExpireCommandSchema = Type.Object({
  kind: Type.Literal("expire"),
}, { additionalProperties: false });

export const CloseCommandSchema = Type.Object({
  kind: Type.Literal("close"),
  id: Type.String({ minLength: 1 }),
  initiator: Type.Optional(StopInitiatorSchema),
}, { additionalProperties: false });

export const ReplaceLimitsCommandSchema = Type.Object({
  kind: Type.Literal("replace-limits"),
  limits: ConcurrencyLimitsSchema,
}, { additionalProperties: false });

export const ArmDebugFaultCommandSchema = Type.Object({
  kind: Type.Literal("arm-debug-fault"),
  fault: DebugFaultKindSchema,
}, { additionalProperties: false });

export const ClearDebugFaultCommandSchema = Type.Object({
  kind: Type.Literal("clear-debug-fault"),
}, { additionalProperties: false });

export const MarkResultCommandSchema = Type.Object({
  kind: Type.Literal("mark-result"),
  id: Type.String({ minLength: 1 }),
  persisted: Type.Optional(Type.Boolean()),
  consumed: Type.Optional(Type.Boolean()),
  deliveryId: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const DisposeCommandSchema = Type.Object({
  kind: Type.Literal("dispose"),
}, { additionalProperties: false });

export const AgentCommandSchema = Type.Union([
  SpawnCommandSchema,
  StopCommandSchema,
  InteractCommandSchema,
  InspectCommandSchema,
  PinCommandSchema,
  ExpireCommandSchema,
  CloseCommandSchema,
  ReplaceLimitsCommandSchema,
  ArmDebugFaultCommandSchema,
  ClearDebugFaultCommandSchema,
  MarkResultCommandSchema,
  DisposeCommandSchema,
]);

export const InteractionResultSchema = Type.Union([
  Type.Object({
    accepted: Type.Literal(true),
  }, { additionalProperties: false }),
  Type.Object({
    accepted: Type.Literal(false),
    reason: Type.Union([
      Type.Literal("concurrency"),
      Type.Literal("queued"),
      Type.Literal("unavailable"),
    ]),
    concurrencyKey: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
]);

export const AgentCommandResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    snapshot: Type.Optional(AgentSnapshotSchema),
    snapshots: Type.Optional(Type.Array(AgentSnapshotSchema)),
    pinned: Type.Optional(Type.Boolean()),
    stopped: Type.Optional(Type.Boolean()),
    closed: Type.Optional(Type.Boolean()),
    interaction: Type.Optional(InteractionResultSchema),
    expiredIds: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Union([
        Type.Literal("invalid-command"),
        Type.Literal("disposed"),
        Type.Literal("not-found"),
        Type.Literal("session-failure"),
      ]),
      message: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

export const DebugAgentDiagnosticSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  status: AgentStatusSchema,
  session: Type.Union([Type.Literal("live"), Type.Literal("none")]),
  settled: Type.Boolean(),
  resultConsumed: Type.Boolean(),
  resultPersisted: Type.Boolean(),
  debugFaultKind: Type.Optional(DebugFaultKindSchema),
  error: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const DebugDiagnosticsSchema = Type.Object({
  armedFault: Type.Optional(Type.Object({
    kind: DebugFaultKindSchema,
  }, { additionalProperties: false })),
  agents: Type.Array(DebugAgentDiagnosticSchema),
}, { additionalProperties: false });

export type AgentStatus = Static<typeof AgentStatusSchema>;
export type StopInitiator = Static<typeof StopInitiatorSchema>;
export type DebugFaultKind = Static<typeof DebugFaultKindSchema>;
export type LifetimeUsage = Static<typeof LifetimeUsageSchema>;
export type AgentStats = Static<typeof AgentStatsSchema>;
export type AgentSnapshot = Static<typeof AgentSnapshotSchema>;
export type AgentListSnapshot = Static<typeof AgentListSnapshotSchema>;
export type AgentCommand = Static<typeof AgentCommandSchema>;
export type SpawnCommand = Static<typeof SpawnCommandSchema>;
export type InteractionResult = Static<typeof InteractionResultSchema>;
export type AgentCommandResult = Static<typeof AgentCommandResultSchema>;
export type DebugDiagnostics = Static<typeof DebugDiagnosticsSchema>;

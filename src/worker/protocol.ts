import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { TaskBootstrap } from "../drivers/task-bootstrap.js";
import type { DeliveryReceipt, DriveResult, ExecutionSnapshot, StoredDelivery, TaskBinding, TaskDelivery, TaskInput } from "../engine/contracts.js";

// Note: see .agents/notes/implemented/architecture/2026-10-09-durable-worker-isolation.md
export interface WorkerBootstrap {
  path: string;
  parentSessionId: string;
  agentDir: string;
  extensionEntryPath: string;
  create?: TaskBootstrap;
}

export interface WorkerMethods {
  init: { args: WorkerBootstrap; result: { binding: TaskBinding; snapshot: ExecutionSnapshot } };
  accept: { args: { input: TaskInput; requestId: string }; result: string };
  drive: { args: { operationId: string }; result: DriveResult };
  abort: { args: { operationId: string; stoppedBy?: "user" | "agent" }; result: null };
  queue: { args: { kind: "steer" | "followUp"; input: TaskInput; requestId: string }; result: string };
  cancelQueued: { args: { entryId: string }; result: "cancelled" | "already_consumed" | "not_found" };
  snapshot: { args: null; result: ExecutionSnapshot };
  takeOver: { args: null; result: null };
  saveDelivery: { args: TaskDelivery; result: null };
  deliveries: { args: null; result: readonly StoredDelivery[] };
  acknowledge: { args: DeliveryReceipt; result: null };
  acquireLock: { args: { path: string }; result: string };
  cancelLock: { args: { requestId: string }; result: null };
  releaseLock: { args: { leaseId: string }; result: null };
}

type Method = keyof WorkerMethods;
export type Handlers = { [M in Method]?: (args: WorkerMethods[M]["args"], id: string) => Promise<WorkerMethods[M]["result"]> };
export type WireMessage =
  | { type: "request"; id: string; method: Method; args: unknown }
  | { type: "response"; id: string; ok: true; value: unknown }
  | { type: "response"; id: string; ok: false; error: string }
  | { type: "event"; name: "changed" | "warning"; text?: string };

const id = Type.String({ minLength: 1 });
const text = Type.String();
const strings = Type.Array(text);
const number = Type.Number({ minimum: 0 });
const choice = <T extends string[]>(...values: T) => Type.Union(values.map(value => Type.Literal(value)));
const stop = Type.Optional(choice("user", "agent"));
const parent = Type.Object({ sessionId: id, entryId: Type.Union([id, Type.Null()]) });
const input = Type.Object({ text, images: Type.Optional(Type.Array(Type.Object({ type: Type.Literal("image"), data: text, mimeType: id }))) });
const outcome = Type.Object({ status: choice("completed", "turn_limited", "error", "aborted", "stopped"), stoppedBy: stop,
  result: Type.Optional(text), error: Type.Optional(text) });
const result = Type.Object({ operationId: id, outcome, stopRequestedBy: stop, completedAt: number, startedAt: number, sourceEntryIds: strings });
const receipt = Type.Object({ deliveryId: id, parentSessionId: id, entryId: id });
const delivery = Type.Object({ deliveryId: id, taskId: id, operationId: id, parent, kind: choice("automatic", "selection"),
  status: outcome.properties.status, text: id, sourceEntryIds: strings, createdAt: number });
const message = Type.Object({ entryId: id, role: id, text, toolName: Type.Optional(text), isError: Type.Optional(Type.Boolean()),
  parts: Type.Optional(Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("text"), text }), Type.Object({ type: Type.Literal("thinking"), thinking: text }),
    Type.Object({ type: Type.Literal("image") }),
    Type.Object({ type: Type.Literal("toolCall"), name: id, arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
  ]))) });
const snapshot = Type.Object({
  operation: Type.Optional(Type.Object({ operationId: id, cancelling: Type.Boolean(), startedAt: number })),
  lastResult: Type.Optional(result), messages: Type.Array(message), streaming: Type.Optional(message),
  stats: Type.Object({ input: number, output: number, cost: number, toolUses: number, turnCount: number, compactions: number,
    contextPercent: Type.Union([number, Type.Null()]) }),
  retry: Type.Optional(Type.Object({ attempt: number, maxAttempts: number, nextAttemptAt: number })),
  queued: Type.Array(Type.Object({ entryId: id, kind: choice("steer", "followUp", "nextRun", "write"), text, images: input.properties.images })),
  faulted: Type.Boolean(),
});
const resourceSwitch = Type.Union([Type.Boolean(), strings]);
const definition = Type.Object({ name: id, description: text, systemPrompt: text,
  registeredTools: Type.Optional(strings), tools: Type.Optional(resourceSwitch), excludeTools: Type.Optional(strings),
  extensions: Type.Optional(resourceSwitch), excludeExtensions: Type.Optional(strings), mcp: Type.Optional(Type.Boolean()),
  skills: Type.Optional(resourceSwitch), preloadSkills: Type.Optional(Type.Union([Type.Literal(false), strings])),
  maxTurns: Type.Optional(number), maxTokens: Type.Optional(number),
});
const resource = Type.Object({ agentDir: id, cwd: id, projectTrusted: Type.Boolean(),
  model: Type.Object({ id, provider: id, api: id, contextWindow: number, maxTokens: number }),
  thinking: choice("off", "minimal", "low", "medium", "high", "xhigh", "max"),
  policy: Type.Object({ definition, registeredTools: strings, restrictToRegisteredTools: Type.Boolean(), tools: Type.Optional(resourceSwitch),
    extensions: resourceSwitch, skills: resourceSwitch, systemPromptMode: choice("replace", "inherit", "custom"), includeContextFiles: Type.Boolean(), parentModelKey: id }),
  parentSystemPrompt: Type.Optional(text), inheritedState: Type.Optional(Type.Array(Type.Tuple([text, Type.Unknown()]))),
  observationPacking: Type.Optional(Type.Boolean()), actionFusion: Type.Optional(Type.Boolean()), extensionEntryPath: Type.Optional(id),
});
const bootstrap = Type.Object({ path: id, parentSessionId: id, agentDir: id, extensionEntryPath: id,
  create: Type.Optional(Type.Object({ path: id, resources: resource, binding: Type.Unknown() })) });

const schemas: Record<Method, { args: TSchema; result: TSchema }> = {
  init: { args: bootstrap, result: Type.Object({ binding: Type.Unknown(), snapshot }) },
  accept: { args: Type.Object({ input, requestId: id }), result: id },
  drive: { args: Type.Object({ operationId: id }), result: Type.Union([
    Type.Object({ kind: Type.Literal("settled"), result }),
    Type.Object({ kind: Type.Literal("waiting"), operationId: id, reason: choice("retry", "deferred"), notBefore: Type.Optional(number) }),
  ]) },
  abort: { args: Type.Object({ operationId: id, stoppedBy: stop }), result: Type.Null() },
  queue: { args: Type.Object({ kind: choice("steer", "followUp"), input, requestId: id }), result: id },
  cancelQueued: { args: Type.Object({ entryId: id }), result: choice("cancelled", "already_consumed", "not_found") },
  snapshot: { args: Type.Null(), result: snapshot }, takeOver: { args: Type.Null(), result: Type.Null() },
  saveDelivery: { args: delivery, result: Type.Null() },
  deliveries: { args: Type.Null(), result: Type.Array(Type.Object({ delivery, receipt: Type.Optional(receipt) })) },
  acknowledge: { args: receipt, result: Type.Null() },
  acquireLock: { args: Type.Object({ path: id }), result: id },
  cancelLock: { args: Type.Object({ requestId: id }), result: Type.Null() },
  releaseLock: { args: Type.Object({ leaseId: id }), result: Type.Null() },
};
const envelope = Type.Union([
  Type.Object({ type: Type.Literal("request"), id, method: choice(...Object.keys(schemas)), args: Type.Unknown() }),
  Type.Object({ type: Type.Literal("response"), id, ok: Type.Literal(true), value: Type.Unknown() }),
  Type.Object({ type: Type.Literal("response"), id, ok: Type.Literal(false), error: text }),
  Type.Object({ type: Type.Literal("event"), name: choice("changed", "warning"), text: Type.Optional(text) }),
]);

export function parseWire(value: unknown): WireMessage {
  if (!Check(envelope, value)) throw new Error("Invalid worker IPC message");
  return value as WireMessage;
}

/** Requests share correlation and validation rules in both directions. */
export class WorkerRpc {
  private readonly pending = new Map<string, { method: Method; resolve(value: any): void; reject(error: Error): void }>();
  private failure?: Error;

  constructor(private readonly send: (message: WireMessage) => Promise<void>, private readonly handlers: Handlers,
    private readonly event: (message: Extract<WireMessage, { type: "event" }>) => void) {}

  call<M extends Method>(method: M, args: WorkerMethods[M]["args"], requestId: string = randomUUID()): Promise<WorkerMethods[M]["result"]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.has(requestId)) return Promise.reject(new Error("Worker request is already pending"));
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { method, resolve, reject });
      void this.send({ type: "request", id: requestId, method, args }).catch(error => {
        this.pending.delete(requestId); reject(error);
      });
    });
  }

  async receive(raw: unknown): Promise<void> {
    const message = parseWire(raw);
    if (this.failure) return;
    if (message.type === "event") { this.event(message); return; }
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (!message.ok) pending.reject(new Error(message.error));
      else if (!Check(schemas[pending.method].result, message.value)) {
        const error = new Error(`Invalid worker response: ${pending.method}`);
        pending.reject(error); throw error;
      } else pending.resolve(message.value);
      return;
    }
    try {
      const handler = this.handlers[message.method];
      if (!handler || !Check(schemas[message.method].args, message.args)) throw new Error(`Invalid worker request: ${message.method}`);
      if (message.method === "init") {
        const init = message.args as WorkerBootstrap;
        if (![init.path, init.agentDir, init.extensionEntryPath].every(isAbsolute) || (init.create && init.create.path !== init.path)) {
          throw new Error("Invalid worker bootstrap paths");
        }
      }
      const value = await (handler as (args: unknown, id: string) => Promise<unknown>)(message.args, message.id);
      await this.send({ type: "response", id: message.id, ok: true, value });
    } catch (error) {
      await this.send({ type: "response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  close(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

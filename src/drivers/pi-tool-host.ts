import { runToolCall, type AgentHarnessTool, type AgentMessage, type AgentTool, type AgentToolCallOutcome,
  type ExecutionToolContext, type JsonValue } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context as ProviderContext, NestedToolCallRecord, Usage } from "@earendil-works/pi-ai";
import type { ExecuteToolOptions, ExtensionRunner, RegisteredTool, ToolDefinition, ToolInfo, ToolLoadout } from "@earendil-works/pi-coding-agent";
import type { TaskPolicy, ToolSourceGrant } from "../domain/policy.js";
import { EXCLUDED_TOOL_NAMES } from "../agents/agent-types.js";

interface CallScope {
  nextId: number;
  holdsQueue: boolean;
  pending: Set<Promise<AgentToolCallOutcome>>;
  root: { calls: NestedToolCallRecord[]; bytes: number; complete: boolean; usage?: Usage };
}

function addUsage(left: Usage | undefined, right: Usage): Usage {
  if (!left) return structuredClone(right);
  return { input: left.input + right.input, output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: { input: left.cost.input + right.cost.input, output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead, cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total } };
}

/** Session-local tool policy, declarations and nested execution over official Pi definitions. */
export class PiToolHost {
  private readonly definitions = new Map<string, RegisteredTool>();
  private readonly safeTools = new Set<string>();
  private readonly outcomes = new Map<string, boolean>();
  private readonly scopes = new Map<string, CallScope>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private exclusive: Promise<void> = Promise.resolve();
  private active: string[] = [];
  private hidden = new Set<string>();
  private descriptions = new Map<string, string>();
  private policy?: Pick<TaskPolicy, "tools" | "toolSources">;
  private restoring = false;
  private runner!: ExtensionRunner;
  readonly tools: AgentHarnessTool<ExecutionToolContext>[] = [];

  constructor(private readonly host: {
    assertOpen(): void;
    flush(): Promise<void>;
    changed(): void;
    messages(): AgentMessage[];
    warn(message: string): void;
  }) {}

  bind(runner: ExtensionRunner): void { this.runner = runner; }
  get activeTools(): string[] { return [...this.active]; }
  get toolNames(): string[] { return this.tools.map(tool => tool.name); }

  permits(name: string, source?: string): boolean {
    if (EXCLUDED_TOOL_NAMES.includes(name)) return false;
    if (!this.policy) return true;
    source ??= this.definitions.get(name)?.sourceInfo.path;
    const grant = this.policy.toolSources?.find(item => item.source === source);
    if (grant) return !grant.exclude.includes(name) && (grant.tools === true || grant.tools.includes(name));
    if (this.policy.toolSources && source && !this.safeBuiltin(source)) return false;
    // Exact grants also serve hosts that have no extension resources.
    return this.policy.tools.includes(name);
  }

  private safeBuiltin(source: string): boolean {
    return ["read", "bash", "powershell", "edit", "write", "grep", "find"].some(name => source === `builtin:${name}`);
  }

  accept(tools: readonly string[], toolSources?: readonly ToolSourceGrant[], restoring = false): void {
    this.policy = { tools: [...tools], toolSources };
    this.restoring = restoring;
    this.active = this.active.filter(name => this.permits(name));
    this.rebuild();
  }

  register(registered: RegisteredTool, safe = false): void {
    const { definition: tool } = registered;
    if (EXCLUDED_TOOL_NAMES.includes(tool.name)) return;
    const previous = this.definitions.get(tool.name);
    this.definitions.set(tool.name, registered);
    if (safe) this.safeTools.add(tool.name); else this.safeTools.delete(tool.name);
    const exposure = tool.exposure ?? "direct";
    if (!this.restoring && !previous && tool.defaultActive !== false && (exposure === "direct" || exposure === "model-only")
      && this.permits(tool.name) && !this.active.includes(tool.name)) this.active.push(tool.name);
    if (exposure === "hidden") this.active = this.active.filter(name => name !== tool.name);
  }

  refresh(): void {
    this.host.assertOpen();
    for (const tool of this.runner.getAllRegisteredTools()) this.register(tool);
    this.rebuild();
    this.host.changed();
  }

  setActiveTools(names: readonly string[]): void {
    this.host.assertOpen();
    // Retain names during startup and resume while their accepted provider is connecting.
    this.active = [...new Set(names)].filter(name => !EXCLUDED_TOOL_NAMES.includes(name)
      && (!this.definitions.has(name) || (this.permits(name) && this.exposure(name) !== "hidden")));
    this.rebuild();
    this.host.changed();
  }

  restoreActiveTools(names: readonly string[]): void {
    for (const name of names) {
      const pending = !this.definitions.has(name) && this.policy?.toolSources?.some(grant =>
        !grant.exclude.includes(name) && (grant.tools === true || grant.tools.includes(name)));
      if (EXCLUDED_TOOL_NAMES.includes(name) || (!this.permits(name) && !pending)) {
        throw new Error(`Persisted active tool exceeds its accepted policy: ${name}`);
      }
    }
    this.setActiveTools(names);
  }

  allTools(): ToolInfo[] {
    return [...this.definitions.values()].filter(({ definition, sourceInfo }) => this.permits(definition.name, sourceInfo.path))
      .map(({ definition, sourceInfo }) => ({ name: definition.name, description: definition.description,
        parameters: definition.parameters, promptGuidelines: definition.promptGuidelines,
        exposure: definition.exposure ?? "direct", namespace: definition.namespace, annotations: definition.annotations, sourceInfo }));
  }

  private exposure(name: string) { return this.definitions.get(name)?.definition.exposure ?? "direct"; }
  private available(): RegisteredTool[] {
    return [...this.definitions.values()].filter(({ definition, sourceInfo }) => this.permits(definition.name, sourceInfo.path));
  }
  private callable(name: string): boolean {
    const exposure = this.exposure(name);
    return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && this.active.includes(name));
  }
  callableTools(): AgentTool[] { return this.available().filter(({ definition }) => this.callable(definition.name)).map(tool => this.wrap(tool.definition)); }

  private wrap(tool: ToolDefinition): AgentTool {
    return { ...tool, execute: (id, args, signal, update) => tool.execute(id, args, signal, update, this.runner.createToolContext(id, signal)) };
  }

  private rebuild(): void {
    const registered = this.available().map(({ definition }) => this.wrap(definition));
    const declared = registered.filter(tool => this.active.includes(tool.name) && this.exposure(tool.name) !== "hidden");
    const loadout: ToolLoadout = { registered, declared, callable: registered.filter(tool => this.callable(tool.name)),
      getExposure: name => this.exposure(name), getNamespace: name => this.definitions.get(name)?.definition.namespace };
    this.hidden = new Set(); this.descriptions = new Map();
    for (const tool of declared) {
      try {
        const changes = this.definitions.get(tool.name)!.definition.prepareLoadout?.(loadout);
        for (const [name, description] of Object.entries(changes?.descriptions ?? {})) this.descriptions.set(name, description);
        for (const name of changes?.hiddenDeclarations ?? []) this.hidden.add(name);
      } catch (error) { this.host.warn(`Child tool ${tool.name} (prepare_loadout): ${error}`); }
    }
    const tools = registered.filter(tool => this.exposure(tool.name) !== "hidden").map(tool => ({
      name: tool.name, label: tool.label, description: this.descriptions.get(tool.name) ?? tool.description,
      parameters: tool.parameters, executionMode: tool.executionMode, replay: this.safeTools.has(tool.name) ? "safe" : "never",
      execute: async (id, args, update, _toolContext, _invocation, callContext) => {
        const operation = this.run(id, tool.name, args, { signal: callContext.abortSignal, onUpdate: update });
        this.inflight.add(operation);
        try {
          const outcome = await operation;
          this.outcomes.set(id, outcome.isError);
          return outcome.result;
        } finally { this.inflight.delete(operation); }
      },
    } satisfies AgentHarnessTool<ExecutionToolContext>));
    this.tools.splice(0, this.tools.length, ...tools);
  }

  /** Request-only declaration changes leave the lane's persisted active set intact. */
  projectRequest(request: ProviderContext): ProviderContext {
    const visible = (name: string) => this.active.includes(name) && this.permits(name)
      && this.exposure(name) !== "hidden" && !this.hidden.has(name);
    const project = <T extends { name: string; description: string }>(tool: T): T => ({ ...tool, description: this.descriptions.get(tool.name) ?? tool.description });
    return { ...request, ...(request.tools ? { tools: request.tools.filter(tool => visible(tool.name)).map(project) } : {}),
      messages: request.messages.map(message => message.role !== "system" ? message : { ...message,
        ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.filter(tool => visible(tool.name)).map(project) } : {}) }) };
  }

  takeOutcome(id: string): { isError: boolean } | undefined {
    const isError = this.outcomes.get(id); this.outcomes.delete(id);
    return isError === undefined ? undefined : { isError };
  }

  executeNested(callerId: string, name: string, args: unknown, options: ExecuteToolOptions = {}): Promise<AgentToolCallOutcome> {
    const caller = this.scopes.get(callerId);
    if (!caller) return Promise.resolve({ toolCall: { type: "toolCall", id: `${callerId}/0`, name, arguments: {} },
      result: { content: [{ type: "text", text: "The calling tool is no longer running" }], details: {} }, isError: true });
    const id = `${callerId}/${caller.nextId++}`;
    const operation = this.run(id, name, args, options, callerId, caller.root);
    caller.pending.add(operation);
    void operation.then(() => caller.pending.delete(operation), () => caller.pending.delete(operation));
    return operation;
  }

  private async run(id: string, name: string, args: unknown, options: ExecuteToolOptions,
    parentToolCallId?: string, root: CallScope["root"] = { calls: [], bytes: 0, complete: true }): Promise<AgentToolCallOutcome> {
    this.host.assertOpen(); await this.host.flush();
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    const scope: CallScope = { nextId: 1, pending: new Set(), root,
      holdsQueue: parentToolCallId ? this.scopes.get(parentToolCallId)?.holdsQueue ?? false : false };
    this.scopes.set(id, scope);
    let release: (() => void) | undefined;
    // A sequential nested tool owns the queue until its descendants return; descendants must not wait on their owner.
    if (parentToolCallId && this.definitions.get(name)?.definition.executionMode === "sequential" && !scope.holdsQueue) {
      const previous = this.exclusive;
      this.exclusive = new Promise<void>(resolve => { release = resolve; });
      await previous;
      scope.holdsQueue = true;
    }
    const toolCall = { type: "toolCall" as const, id, name, arguments: (args ?? {}) as Record<string, JsonValue> };
    const started = performance.now();
    let record: NestedToolCallRecord | undefined;
    if (parentToolCallId) {
      let bytes = Infinity;
      try { bytes = Buffer.byteLength(JSON.stringify(toolCall.arguments)); }
      catch { /* Non-JSON input is rejected by the tool pipeline; omit it from the diagnostic record. */ }
      if (root.calls.length < 256) {
        record = { id, name, status: "unfinished" };
        if (bytes <= 8192 && root.bytes + bytes <= 32768) { record.arguments = structuredClone(toolCall.arguments); root.bytes += bytes; }
        else { if (Number.isFinite(bytes)) record.argumentsBytes = bytes; root.complete = false; }
        root.calls.push(record);
      } else root.complete = false;
    }
    try {
      if (parentToolCallId) await this.runner.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args, parentToolCallId });
      const messages = this.host.messages();
      let assistantMessage: AssistantMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          assistantMessage = messages[i] as AssistantMessage;
          break;
        }
      }
      if (!assistantMessage) throw new Error("No assistant message issued this child tool call");
      const tools = this.available().filter(({ definition }) => parentToolCallId ? this.callable(definition.name)
        : this.active.includes(definition.name) && this.exposure(definition.name) !== "hidden").map(({ definition }) => this.wrap(definition));
      const outcome = await runToolCall(toolCall, { tools, assistantMessage, context: { messages, tools }, signal,
        onUpdate: async partialResult => {
          options.onUpdate?.(partialResult);
          if (parentToolCallId) await this.runner.emit({ type: "tool_execution_update", toolCallId: id, toolName: name, args, partialResult, parentToolCallId });
        },
        beforeToolCall: async event => {
          signal.throwIfAborted(); await this.host.flush();
          if (!this.permits(name) || (parentToolCallId ? !this.callable(name) : !this.active.includes(name)) || this.exposure(name) === "hidden") {
            return { block: true, reason: `Tool is not available: ${name}` };
          }
          return await this.runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: id, input: event.args as Record<string, unknown>, parentToolCallId });
        },
        afterToolCall: event => this.runner.emitToolResult({ type: "tool_result", toolName: name, toolCallId: id,
          input: event.args as Record<string, unknown>, ...event.result, isError: event.isError, parentToolCallId }),
      });
      // An extension cannot release its owner while fire-and-forget nested effects are still running.
      while (scope.pending.size) await Promise.allSettled([...scope.pending]);
      await this.host.flush();
      if (parentToolCallId) {
        if (outcome.result.usage) root.usage = addUsage(root.usage, outcome.result.usage);
        if (record) {
          record.status = outcome.isError ? "error" : "ok"; record.durationMs = Math.round(performance.now() - started);
          if (outcome.isError) record.error = outcome.result.content.filter(block => block.type === "text").map(block => block.text).join("\n").slice(0, 500);
        }
        await this.runner.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: outcome.result, isError: outcome.isError, parentToolCallId });
      } else {
        if (root.usage) outcome.result.usage = addUsage(outcome.result.usage, root.usage);
        if (root.calls.length || !root.complete) outcome.result.details = {
          ...(outcome.result.details && typeof outcome.result.details === "object" && !Array.isArray(outcome.result.details)
            ? outcome.result.details : { toolDetails: outcome.result.details ?? null }),
          nestedCalls: { calls: root.calls, complete: root.complete },
        };
      }
      return outcome;
    } finally {
      while (scope.pending.size) await Promise.allSettled([...scope.pending]);
      this.scopes.delete(id); release?.();
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.inflight]);
    this.outcomes.clear();
  }
}

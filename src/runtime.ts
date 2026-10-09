import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import { AgentCatalogue } from "./agents/agent-types.js";
import type { AcceptedRunPolicy } from "./agents/types.js";
import { resolveWorkingDirectory } from "./agents/working-directory.js";
import { ConfigStore, type ConfigIO } from "./config/config-store.js";
import { loadConfig, saveConfigAtomic } from "./config/config-io.js";
import { openTask, type TaskBootstrap } from "./drivers/task-bootstrap.js";
import { WorkerExecutionDriver } from "./drivers/worker-driver.js";
import type { WorkerBootstrap } from "./worker/protocol.js";
import type { ExecutionDriver, TaskBinding } from "./engine/contracts.js";
import { FileLockManager } from "./drivers/file-locks.js";
import { NativeTaskStore } from "./drivers/native-task-store.js";
import { PiDeliveryChannel } from "./drivers/pi-delivery-channel.js";
import type { ResourceHost } from "./drivers/pi-resources.js";
import { TaskEngine } from "./engine/task-engine.js";
import { AgentNavigator } from "./ui/agent-navigator.js";
import { TaskNavigationSource } from "./ui/task-source.js";

interface RuntimeOptions {
  agentDir?: string;
  sessionsRoot?: string;
  configIO?: ConfigIO;
}

// Note: see .agents/notes/implemented/architecture/2026-09-12-explicit-runtime-and-native-task-ownership.md
export class ExtensionRuntime {
  readonly catalogue = new AgentCatalogue();
  readonly agentDir: string;
  readonly store: ConfigStore;
  engine!: TaskEngine;
  navigator?: AgentNavigator;
  source?: TaskNavigationSource;
  private ctx?: ExtensionContext;
  private parentId?: string;
  private parentFile?: string;
  private sessionsRoot!: string;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  // Dedupes built-in tool conflict warnings across this parent session's children.
  private readonly warnedConflicts = new Set<string>();
  // Serializes fused mutation+command operations per file across all child sessions.
  private readonly fusedFileQueue = new FileLockManager();
  private readonly ownedSessions = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(readonly pi: ExtensionAPI, private readonly options: RuntimeOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    const configPath = join(this.agentDir, "subagents-lite-v3.json");
    this.store = new ConfigStore(options.configIO ?? { load: () => loadConfig(configPath), save: config => saveConfigAtomic(config, configPath) });
  }

  get active(): boolean { return !this.lifetime.signal.aborted; }
  get context(): ExtensionContext { this.assertActive(); if (!this.ctx) throw new Error("Subagent runtime is not initialized"); return this.ctx; }

  assertActive(): void { this.lifetime.signal.throwIfAborted(); }
  assertContext(ctx: ExtensionContext): void {
    this.assertActive();
    if (ctx.sessionManager.getSessionId() !== this.parentId || ctx.sessionManager.getSessionFile() !== this.parentFile) {
      throw new Error("The callback belongs to another parent session");
    }
  }

  updateContext(ctx: ExtensionContext): void { this.assertContext(ctx); this.ctx = ctx; }

  start(ctx: ExtensionContext): Promise<void> {
    this.assertActive();
    if (this.starting) { this.assertContext(ctx); return this.starting; }
    this.ctx = ctx;
    this.parentId = ctx.sessionManager.getSessionId();
    this.parentFile = ctx.sessionManager.getSessionFile();
    this.starting = this.initialize().catch(async error => { await this.dispose(); throw error; });
    return this.starting;
  }

  private async initialize(): Promise<void> {
    const ctx = this.context;
    this.catalogue.setAgentScanDirs(join(this.agentDir, "agents"), ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "agents") : "",
      this.store.agent.disableDefaultAgents);
    const definitions = await this.catalogue.scanAndMerge({ disableDefaultAgents: this.store.agent.disableDefaultAgents });
    this.assertActive();
    this.catalogue.registerAgents(definitions, { disableDefaultAgents: this.store.agent.disableDefaultAgents });
    this.sessionsRoot = join(this.options.sessionsRoot ?? join(this.agentDir, "subagents-lite-v3", "durable"), encodeURIComponent(this.parentId!));
    mkdirSync(this.sessionsRoot, { recursive: true });
    this.engine = new TaskEngine(this.store.concurrency, new PiDeliveryChannel(this.pi, () => this.context));
    this.source = new TaskNavigationSource(this.engine);
    this.navigator = new AgentNavigator(this.source, undefined, () => this.engine.pendingResults(), () => ({
      providerName: this.ctx?.model?.provider, modelName: this.ctx?.model?.id, thinkingLevel: this.ctx?.thinkingLevel,
    }), this.store.agent.expandListByDefault);
    this.store.setDeps({ engine: this.engine, navigator: this.navigator, catalogue: this.catalogue });
    if (ctx.mode === "tui") this.navigator.setUICtx(ctx.ui);
    for (const file of readdirSync(this.sessionsRoot).filter(file => file.endsWith(".sqlite"))) {
      this.assertActive();
      try { await this.restore(join(this.sessionsRoot, file)); } catch (error) { this.assertActive(); this.report(error); }
    }
    this.assertActive();
    await this.source.refresh();
    await this.flushDeliveries();
  }

  private restore(path: string): Promise<void> {
    return this.track(async () => {
      if (path.endsWith(".worker.sqlite")) {
        const host = this.resourceHost(this.context, this.lifetime.signal);
        const driver = await WorkerExecutionDriver.open(this.workerBootstrap(path), { locks: this.fusedFileQueue, warn: host.warn, signal: this.lifetime.signal });
        await this.attachRestored(driver, path);
        return;
      }
      const session = createSession(await openNodeSqliteStorage(path));
      let binding;
      try { binding = (await NativeTaskStore.open(session, undefined, path)).binding; }
      finally { await session.close(BACKGROUND_CONTEXT); }
      if (binding.parent.sessionId !== this.parentId) throw new Error("Restored task belongs to another parent");
      if (binding.execution?.backend === "worker") throw new Error("Worker task storage has an invalid filename");
      const policy = binding.policy;
      await resolveWorkingDirectory(policy.cwd, policy.cwd);
      const model = this.context.modelRegistry.find(policy.model.provider, policy.model.id);
      if (!model) throw new Error(`Accepted model is unavailable: ${policy.model.provider}/${policy.model.id}`);
      const driver = await openTask({ path, resources: { agentDir: this.agentDir,
        cwd: policy.cwd, projectTrusted: binding.resources?.trusted ?? this.context.isProjectTrusted(),
        model, thinking: policy.thinkingLevel, restored: binding,
        observationPacking: binding.execution?.observationPacking ?? (this.store.experimental.observationPacking || policy.tools.includes("obs_recall") || existsSync(`${path}.observations`)),
        actionFusion: binding.execution?.actionFusion ?? this.store.experimental.actionFusion,
        extensionEntryPath: join(import.meta.dirname, "index.ts"),
      } }, this.resourceHost(this.context, this.lifetime.signal));
      await this.attachRestored(driver, path);
    });
  }

  private async attachRestored(driver: ExecutionDriver, path: string): Promise<void> {
    try {
      this.assertActive();
      const snapshot = await driver.snapshot();
      if (!snapshot.operation && !snapshot.lastResult) { await driver.close(); return; }
      await this.engine.restore(driver); this.ownedSessions.add(path);
    } catch (error) { await driver.close(); throw error; }
  }

  async spawn(options: {
    ctx: ExtensionContext; parentEntryId: string | null; prompt: string; description: string; acceptedPolicy: AcceptedRunPolicy;
    model: Model<any>; thinkingLevel: ThinkingLevel; graceTurns: number;
    cwd: string; projectTrusted: boolean; runInBackground: boolean; signal?: AbortSignal;
  }) {
    this.assertContext(options.ctx);
    const task = await this.track(async () => {
      const { acceptedPolicy, model, thinkingLevel, runInBackground, cwd, projectTrusted } = options;
      const signal = options.signal && !runInBackground ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
      const parent = { sessionId: this.parentId!, entryId: options.parentEntryId };
      const maxTurns = acceptedPolicy.definition.maxTurns;
      const maxTokens = acceptedPolicy.definition.maxTokens;
      const limits = { maxTurns: maxTurns ? Math.max(1, Math.ceil(maxTurns)) : undefined,
        maxTokens: maxTokens && maxTokens > 0 ? Math.ceil(maxTokens) : undefined, graceTurns: options.graceTurns };
      for (const value of [limits.maxTurns, limits.maxTokens]) {
        if (value !== undefined && !Number.isSafeInteger(value)) throw new Error("Task limits must be safe integers");
      }
      const inheritedState = new Map<string, unknown>();
      for (const entry of options.ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && !entry.customType.startsWith("subagents-lite")) inheritedState.set(entry.customType, structuredClone(entry.data));
      }
      const experimental = this.store.experimental;
      const taskId = randomUUID();
      const path = join(this.sessionsRoot, `${taskId}${experimental.executionBackend === "worker" ? ".worker" : ""}.sqlite`);
      const binding: TaskBinding = { taskId, parent, mode: runInBackground ? "background" : "foreground", control: "autonomous",
        display: { name: acceptedPolicy.definition.displayName ?? acceptedPolicy.definition.name, description: options.description },
        execution: { backend: experimental.executionBackend, model, observationPacking: experimental.observationPacking,
          actionFusion: experimental.actionFusion, requireRegisteredProvider: experimental.executionBackend === "worker"
            && options.ctx.modelRegistry.getRegisteredProviderIds().includes(model.provider), settings: {} },
        policy: { agent: acceptedPolicy.definition.name, model: { provider: model.provider, id: model.id }, thinkingLevel,
          cwd, tools: [], systemPrompt: "", limits },
      };
      const bootstrap: TaskBootstrap = { path, binding, resources: { agentDir: this.agentDir,
        cwd, projectTrusted, model, thinking: thinkingLevel, policy: acceptedPolicy,
        parentSystemPrompt: acceptedPolicy.systemPromptMode === "inherit" ? options.ctx.getSystemPrompt() : undefined,
        inheritedState: [...inheritedState], observationPacking: experimental.observationPacking,
        actionFusion: experimental.actionFusion, extensionEntryPath: join(import.meta.dirname, "index.ts"),
      } };
      const host = this.resourceHost(options.ctx, signal);
      this.ownedSessions.add(path);
      let attached = false;
      try {
        const driver = experimental.executionBackend === "worker"
          ? await WorkerExecutionDriver.open({ ...this.workerBootstrap(path), create: bootstrap }, { locks: this.fusedFileQueue, warn: host.warn, signal })
          : await openTask(bootstrap, host);
        try { signal.throwIfAborted(); this.assertContext(options.ctx); const accepted = await this.engine.accept(driver, { text: options.prompt }); attached = true; return accepted; }
        catch (error) { await driver.close(); throw error; }
      } finally {
        if (!attached) this.ownedSessions.delete(path);
      }
    });
    if (options.runInBackground) return { task, detached: false };
    const abort = () => {
      if (this.active) void this.engine.requestAbort(task.taskId, "user").catch(error => this.report(error));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const result = await this.engine.wait(task.taskId, options.signal);
      return { task: result, detached: result.control === "manual" && result.state.status !== "settled" };
    } finally { options.signal?.removeEventListener("abort", abort); }
  }

  async storedResult(taskId: string) {
    this.assertActive();
    for (const file of readdirSync(this.sessionsRoot).filter(file => file.endsWith(".sqlite"))) {
      this.assertActive();
      const path = join(this.sessionsRoot, file);
      if (this.ownedSessions.has(path)) continue;
      if (path.endsWith(".worker.sqlite")) {
        const stored = await WorkerExecutionDriver.readStored(this.workerBootstrap(path));
        if (stored.binding.taskId === taskId) return stored;
        continue;
      }
      const session = createSession(await openNodeSqliteStorage(path));
      try {
        const store = await NativeTaskStore.open(session, undefined, path);
        if (store.binding.parent.sessionId !== this.parentId) throw new Error("Stored task belongs to another parent");
        if (store.binding.taskId !== taskId) continue;
        return { binding: store.binding, result: await store.latestResult(), deliveries: await store.deliveries() };
      } finally { await session.close(BACKGROUND_CONTEXT); }
    }
    return undefined;
  }

  private workerBootstrap(path: string): WorkerBootstrap {
    return { path, parentSessionId: this.parentId!, agentDir: this.agentDir, extensionEntryPath: join(import.meta.dirname, "index.ts") };
  }

  private resourceHost(ctx: ExtensionContext, signal: AbortSignal): ResourceHost {
    const providers = ctx.modelRegistry.getRegisteredProviderIds().map(id => ({ id,
      provider: ctx.modelRegistry.getRegisteredNativeProvider(id), config: ctx.modelRegistry.getRegisteredProviderConfig(id) }));
    return {
      exec: (command, args, options) => this.pi.exec(command, args, options),
      signal, warnedConflicts: this.warnedConflicts, fusedFileQueue: this.fusedFileQueue,
      warn: message => { if (this.active) {
        if (ctx.hasUI) ctx.ui.notify(`[subagents] ${message}`, "warning");
        else console.warn(`[subagents] ${message}`);
      } },
      configureModels: models => {
        for (const { id, provider, config } of providers) {
          if (provider) models.registerNativeProvider(provider);
          else if (config) models.registerProvider(id, config);
        }
      },
    };
  }

  async flushDeliveries(): Promise<void> {
    if (!this.active || !this.engine) return;
    try { await this.engine.flushDeliveries(); } catch (error) { this.report(error); }
  }

  reflow(): void {
    if (!this.active) return;
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.active) this.navigator?.forceLayoutReflow(); }, 0);
    this.timers.add(timer);
  }

  report(error: unknown): void {
    if (!this.active) return;
    if (this.ctx?.hasUI) this.ctx.ui.notify(String(error), "error");
    else console.error("[subagents]", String(error));
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const work = Promise.resolve().then(operation);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => { /* The original caller owns the operation failure. */ });
    return work;
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort(new Error("Subagent runtime is closed"));
    this.store.dispose();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const cleanup = async (action: () => unknown) => { try { await action(); } catch (error) { failures.push(error); } };
      await cleanup(() => this.navigator?.dispose());
      await cleanup(() => this.source?.dispose());
      await cleanup(() => this.engine?.close());
      await Promise.allSettled([...this.pending]);
      if (failures.length) throw new AggregateError(failures, "Subagent runtime cleanup failed");
    });
    return this.closing;
  }
}

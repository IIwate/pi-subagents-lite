import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { AgentCatalogue } from "./agents/agent-types.js";
import { ConfigStore, type ConfigIO } from "./config/config-store.js";
import { loadConfig, saveConfigAtomic } from "./config/config-io.js";
import { HarnessDriver } from "./drivers/harness-driver.js";
import { NativeTaskStore } from "./drivers/native-task-store.js";
import { PiDeliveryChannel } from "./drivers/pi-delivery-channel.js";
import { PiResources } from "./drivers/pi-resources.js";
import { TaskEngine } from "./engine/task-engine.js";
import { AgentNavigator } from "./ui/agent-navigator.js";
import { TaskNavigationSource } from "./ui/task-source.js";
import type { AcceptedRunPolicy, ThinkingLevel } from "./types.js";

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
  private repository?: JsonlSessionRepo;
  private env?: NodeExecutionEnv;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly resources = new Set<PiResources>();
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
    this.env = new NodeExecutionEnv({ cwd: ctx.cwd });
    this.repository = new JsonlSessionRepo({ fileSystem: this.env, sessionsRoot: this.options.sessionsRoot ?? join(this.agentDir, "subagents-lite-v3", "sessions") });
    this.engine = new TaskEngine(this.store.concurrency, new PiDeliveryChannel(this.pi, () => this.context));
    this.source = new TaskNavigationSource(this.engine);
    this.navigator = new AgentNavigator(this.source, undefined, () => this.engine.pendingResults(), () => ({
      providerName: this.ctx?.model?.provider, modelName: this.ctx?.model?.id, thinkingLevel: this.ctx?.thinkingLevel,
    }), this.store.agent.expandListByDefault);
    this.store.setDeps({ engine: this.engine, navigator: this.navigator, catalogue: this.catalogue });
    if (ctx.mode === "tui") this.navigator.setUICtx(ctx.ui);
    for (const metadata of await this.repository.list(undefined, BACKGROUND_CONTEXT)) {
      this.assertActive();
      if (metadata.parentSessionId !== this.parentId) continue;
      try { await this.restore(metadata); } catch (error) { this.assertActive(); this.report(error); }
    }
    this.assertActive();
    await this.source.refresh();
    await this.flushDeliveries();
  }

  private restore(metadata: Awaited<ReturnType<JsonlSessionRepo["list"]>>[number]): Promise<void> {
    return this.track(async () => {
      const session = await this.repository!.open(metadata, BACKGROUND_CONTEXT);
      this.ownedSessions.add(session.metadata.id);
      let resources: PiResources | undefined;
      let transferred = false;
      let attached = false;
      try {
        this.assertActive();
        const store = await NativeTaskStore.open(session);
        this.assertActive();
        if (store.binding.parent.sessionId !== this.parentId) throw new Error("Restored task belongs to another parent");
        const policy = store.binding.policy;
        const model = this.context.modelRegistry.find(policy.model.provider, policy.model.id);
        if (!model) throw new Error(`Accepted model is unavailable: ${policy.model.provider}/${policy.model.id}`);
        resources = await PiResources.open({ pi: this.pi, parent: this.context, agentDir: this.agentDir,
          cwd: policy.cwd, model, thinking: policy.thinkingLevel, restored: store.binding, signal: this.lifetime.signal });
        this.resources.add(resources);
        this.assertActive();
        transferred = true;
        const driver = await HarnessDriver.open({ session, models: resources.models, piResources: resources,
          retry: resources.settings.getRetrySettings(), compaction: resources.settings.getCompactionSettings() });
        try {
          this.assertActive();
          const snapshot = await driver.snapshot();
          if (!snapshot.operation && !snapshot.lastResult) { await driver.close(); this.ownedSessions.delete(session.metadata.id); return; }
          await this.engine.restore(driver);
          attached = true;
        } catch (error) { await driver.close(); this.ownedSessions.delete(session.metadata.id); throw error; }
      } finally {
        if (!transferred) {
          try { await resources?.close(); } finally { await session.close(BACKGROUND_CONTEXT); this.ownedSessions.delete(session.metadata.id); }
        }
        if (!attached) this.ownedSessions.delete(session.metadata.id);
        if (resources) this.resources.delete(resources);
      }
    });
  }

  async spawn(options: {
    ctx: ExtensionContext; parentEntryId: string | null; prompt: string; description: string; acceptedPolicy: AcceptedRunPolicy;
    model: Model<any>; thinkingLevel: ThinkingLevel; graceTurns: number;
    worktreePath?: string; runInBackground: boolean; signal?: AbortSignal;
  }) {
    this.assertContext(options.ctx);
    const task = await this.track(async () => {
      const { acceptedPolicy, model, thinkingLevel, runInBackground } = options;
      const signal = options.signal && !runInBackground ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
      const cwd = options.worktreePath ?? options.ctx.cwd;
      const parent = { sessionId: this.parentId!, entryId: options.parentEntryId };
      const maxTurns = acceptedPolicy.definition.maxTurns;
      const maxTokens = acceptedPolicy.definition.maxTokens;
      const limits = { maxTurns: maxTurns ? Math.max(1, Math.ceil(maxTurns)) : undefined,
        maxTokens: maxTokens && maxTokens > 0 ? Math.ceil(maxTokens) : undefined, graceTurns: options.graceTurns };
      for (const value of [limits.maxTurns, limits.maxTokens]) {
        if (value !== undefined && !Number.isSafeInteger(value)) throw new Error("Task limits must be safe integers");
      }
      const resources = await PiResources.open({ pi: this.pi, parent: options.ctx, agentDir: this.agentDir,
        cwd, model, thinking: thinkingLevel, policy: acceptedPolicy, signal });
      this.resources.add(resources);
      let transferred = false;
      let attached = false;
      let nativeId: string | undefined;
      try {
        signal.throwIfAborted(); this.assertContext(options.ctx);
        const session = await this.repository!.create({ cwd, parentSessionId: parent.sessionId }, BACKGROUND_CONTEXT);
        this.ownedSessions.add(session.metadata.id);
        nativeId = session.metadata.id;
        transferred = true;
        const driver = await HarnessDriver.open({ session, models: resources.models, piResources: resources,
          binding: { taskId: randomUUID(), parent, mode: runInBackground ? "background" : "foreground", control: "autonomous",
            display: { name: acceptedPolicy.definition.displayName ?? acceptedPolicy.definition.name, description: options.description },
            resources: { extensions: resources.extensionPaths, trusted: options.ctx.isProjectTrusted() },
            policy: { agent: acceptedPolicy.definition.name, model: { provider: model.provider, id: model.id }, thinkingLevel,
              cwd, tools: resources.toolNames, systemPrompt: resources.systemPrompt,
              limits } },
          retry: resources.settings.getRetrySettings(), compaction: resources.settings.getCompactionSettings(),
        });
        try { signal.throwIfAborted(); this.assertActive(); const accepted = await this.engine.accept(driver, { text: options.prompt }); attached = true; return accepted; }
        catch (error) { await driver.close(); this.ownedSessions.delete(session.metadata.id); throw error; }
      } finally {
        this.resources.delete(resources);
        if (!attached && nativeId) this.ownedSessions.delete(nativeId);
        if (!transferred) await resources.close();
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
    for (const metadata of await this.repository!.list(undefined, BACKGROUND_CONTEXT)) {
      this.assertActive();
      if (metadata.parentSessionId !== this.parentId || this.ownedSessions.has(metadata.id)) continue;
      const session = await this.repository!.open(metadata, BACKGROUND_CONTEXT);
      try {
        const store = await NativeTaskStore.open(session);
        if (store.binding.taskId !== taskId) continue;
        return { binding: store.binding, result: await store.latestResult(), deliveries: await store.deliveries() };
      } finally { await session.close(BACKGROUND_CONTEXT); }
    }
    return undefined;
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
      for (const resources of this.resources) await cleanup(() => resources.close());
      await cleanup(() => this.repository?.close(BACKGROUND_CONTEXT));
      await cleanup(() => this.env?.cleanup(BACKGROUND_CONTEXT));
      this.resources.clear();
      if (failures.length) throw new AggregateError(failures, "Subagent runtime cleanup failed");
    });
    return this.closing;
  }
}

import { readFileSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import {
  createMcpExtension, createCodemodeExtension, createToolSearchExtension,
  createBashTool, createEditTool, createFindTool, createGrepTool, createPowerShellTool, createReadTool, createWriteTool,
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  loadProjectContextFiles, type ExtensionAPI, type ExtensionContext, type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT, getOrThrow, reduceLaneSnapshot, value, type LaneSnapshot, type AgentHarness, type AgentLane, type AgentTool,
  type ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { Context as ProviderContext, Model, ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import type { AcceptedRunPolicy } from "../agents/types.js";
import type { TaskBinding } from "../engine/contracts.js";
import type { NativeTaskStore } from "./native-task-store.js";
import { EXCLUDED_TOOL_NAMES, resolveVisibleTools } from "../agents/agent-types.js";
import { extractText } from "../prompt/context.js";
import { buildAgentPrompt, type EnvInfo, type PromptExtras } from "../prompt/prompts.js";
import { loadSkillMeta, preloadSkills } from "../prompt/skill-loader.js";
import { PiToolHost } from "./pi-tool-host.js";
import type { ToolSourceGrant } from "../domain/policy.js";

const GIT_EXEC_TIMEOUT_MS = 5000;
const context = BACKGROUND_CONTEXT;
const extensionState = value<unknown>("subagents-lite.v3", "extension-state");

function extensionName(file: string): string {
  if (file.startsWith("builtin:")) return file;
  const parts = file.split(sep);
  const npm = parts.lastIndexOf("node_modules");
  if (npm >= 0) return parts[npm + (parts[npm + 1].startsWith("@") ? 2 : 1)];
  const git = parts.indexOf("git");
  if (git >= 0 && git + 3 < parts.length) return parts[git + 3];
  const local = parts.lastIndexOf("extensions");
  if (local >= 0) return extname(parts[local + 1]) ? basename(file, extname(file)) : parts[local + 1];
  return basename(dirname(file));
}

interface ResourceOptions {
  pi: Pick<ExtensionAPI, "exec">;
  parent: ExtensionContext;
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  model: Model<any>;
  thinking: ThinkingLevel;
  policy?: AcceptedRunPolicy;
  restored?: TaskBinding;
  signal?: AbortSignal;
}

/** Owns official Pi resource factories and adapts their tool hooks to the native child. */
export class PiResources {
  private runner!: ExtensionRunner;
  private view: SessionManager;
  private lane?: AgentLane;
  private harness?: AgentHarness<ExecutionToolContext>;
  private store?: NativeTaskStore;
  private writes: Promise<void> = Promise.resolve();
  private writeError?: unknown;
  private closed = false;
  private closing?: Promise<void>;
  private snapshot?: LaneSnapshot;
  private abortSignal?: AbortSignal;
  private readonly stops: Array<() => void> = [];
  private readonly toolHost: PiToolHost;
  private initialTools: readonly string[] = [];
  toolSources: readonly ToolSourceGrant[] = [];
  private readonly customState: Array<[string, unknown]> = [];
  get tools() { return this.toolHost.tools; }
  get activeTools() { return this.toolHost.activeTools; }
  projectRequest(request: ProviderContext): ProviderContext { return this.toolHost.projectRequest(request); }
  systemPrompt = "";
  extensionPaths: string[] = [];

  private constructor(readonly models: ModelRuntime, readonly settings: SettingsManager,
    private readonly loader: DefaultResourceLoader, private readonly options: ResourceOptions) {
    this.view = SessionManager.inMemory(options.cwd);
    this.toolHost = new PiToolHost({ assertOpen: () => this.assertOpen(), flush: () => this.flush(),
      changed: () => this.publishTools(), warn: message => this.warn(message),
      messages: () => this.view.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []),
    });
  }

  static async open(options: ResourceOptions): Promise<PiResources> {
    const { parent, agentDir, cwd, policy, restored } = options;
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted });
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), signal: options.signal });
    for (const id of parent.modelRegistry.getRegisteredProviderIds()) {
      const provider = parent.modelRegistry.getRegisteredNativeProvider(id);
      const config = parent.modelRegistry.getRegisteredProviderConfig(id);
      if (provider) models.registerNativeProvider(provider);
      else if (config) models.registerProvider(id, config);
    }
    const allowed = Array.isArray(policy?.extensions) ? new Set(policy.extensions.map(name => name.split("/")[0])) : undefined;
    const denied = new Set(policy?.definition.excludeExtensions ?? []);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noExtensions: restored !== undefined || policy?.extensions === false,
      extensionFactories: [
        { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
        { name: "codemode", factory: createCodemodeExtension({ models: false }), builtin: true, replaceable: true },
        { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
      ],
      additionalExtensionPaths: restored?.resources ? [...restored.resources.extensions] : undefined,
      noSkills: restored !== undefined || policy?.skills === false || Array.isArray(policy?.skills) || Array.isArray(policy?.definition.preloadSkills),
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => ({ ...result, extensions: result.extensions.filter(extension => {
        if (extension.resolvedPath === join(import.meta.dirname, "..", "index.ts")) return false;
        const name = extensionName(extension.path);
        return allowed ? allowed.has(name) : !denied.has(name);
      }) }),
    });
    const resources = new PiResources(models, settings, loader, options);
    try {
      await loader.reload({ resolveProjectTrust: async () => options.projectTrusted });
      options.signal?.throwIfAborted();
      const loaded = loader.getExtensions();
      if (loaded.errors.length) throw new Error(loaded.errors.map(error => `${error.path}: ${error.error}`).join("\n"));
      resources.extensionPaths = loaded.extensions.map(extension => extension.resolvedPath);
      if (restored?.resources && restored.resources.extensions.some(file => !resources.extensionPaths.includes(file))) {
        throw new Error("An accepted child extension is unavailable");
      }
      resources.systemPrompt = restored?.policy.systemPrompt ?? await resources.buildPrompt(policy!);
      resources.bind();
      if (!restored) {
        const inherited = new Map<string, unknown>();
        for (const entry of parent.sessionManager.getBranch()) {
          if (entry.type === "custom" && !entry.customType.startsWith("subagents-lite")) {
            inherited.set(entry.customType, structuredClone(entry.data));
          }
        }
        resources.customState.push(...inherited);
        for (const [type, data] of resources.customState) resources.view.appendCustomEntry(type, data);
        await resources.runner.emit({ type: "session_start", reason: "new" });
        resources.toolHost.refresh();
        const extTools = new Map(loaded.extensions.map(extension => [extensionName(extension.path), [...extension.tools.keys()]]));
        const all = resources.toolHost.allTools().map(tool => tool.name);
        const active = resolveVisibleTools({ activeTools: Array.isArray(policy!.tools) ? all : resources.activeTools,
          tools: policy!.tools, excludeTools: policy!.definition.excludeTools, extToolMap: extTools,
          notify: message => resources.warn(message),
        }) ?? resources.activeTools;
        resources.toolHost.setActiveTools(active);
        resources.initialTools = resources.toolHost.toolNames;
      }
      return resources;
    } catch (error) { await resources.close(); throw error; }
  }

  get toolNames(): readonly string[] { return this.tools.map(tool => tool.name); }

  private bind(): void {
    const { cwd, policy, restored, model, thinking } = this.options;
    const builtins: AgentTool<any>[] = [createReadTool(cwd), createBashTool(cwd), createPowerShellTool(cwd), createEditTool(cwd),
      createWriteTool(cwd), createGrepTool(cwd), createFindTool(cwd)];
    for (const tool of builtins) this.toolHost.register({ definition: { ...tool, defaultActive: false,
      execute: (id, args, signal, update) => tool.execute(id, args, signal, update) },
      sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level", path: `builtin:${tool.name}` },
    }, ["read", "grep", "find"].includes(tool.name));
    const loaded = this.loader.getExtensions();
    // The runner's synchronous session API reads a projection; only the native session persists child state.
    const view = new Proxy({} as SessionManager, { get: (_target, key) => {
      const member = Reflect.get(this.view, key, this.view);
      return typeof member === "function" ? member.bind(this.view) : member;
    } });
    this.runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, view, new ModelRegistry(this.models));
    this.stops.push(this.runner.onError(error => {
      this.warn(`Child extension ${error.extensionPath} (${error.event}): ${error.error}`);
    }));
    this.toolHost.bind(this.runner);
    const selected = policy?.registeredTools.filter(name => !EXCLUDED_TOOL_NAMES.includes(name)) ?? [...restored!.policy.tools];
    if (policy) {
      this.toolSources = loaded.extensions.map(extension => {
        const name = extensionName(extension.path);
        const entries = (values: readonly string[]) => values.flatMap(entry => {
          const slash = entry.indexOf("/");
          return slash < 0 ? [entry] : entry.slice(0, slash) === name ? [entry.slice(slash + 1)] : [];
        });
        const tools = Array.isArray(policy.tools) ? entries(policy.tools)
          : policy.tools === false ? [] : policy.restrictToRegisteredTools ? selected : true;
        const exclude = Array.isArray(policy.tools) ? [] : entries(policy.definition.excludeTools ?? []);
        return { source: extension.sourceInfo.path, tools: exclude.includes("*") ? [] : tools === true || tools.includes("*") ? true : tools, exclude };
      });
      const exact = resolveVisibleTools({ activeTools: Array.isArray(policy.tools) ? builtins.map(tool => tool.name) : selected,
        tools: policy.tools, excludeTools: policy.definition.excludeTools }) ?? selected;
      this.toolHost.accept(exact, this.toolSources);
    } else {
      this.toolSources = restored!.policy.toolSources ?? [];
      this.initialTools = restored!.policy.tools;
      this.toolHost.accept(restored!.policy.tools, restored!.policy.toolSources, true);
    }
    this.toolHost.setActiveTools(selected);
    const unsupported = () => { throw new Error("Child extensions cannot change the accepted execution policy"); };
    this.runner.bindCore({
      appendEntry: (type, data) => {
        if (this.closed) throw new Error("Child resources are closed");
        this.customState.push([type, structuredClone(data)]); this.view.appendCustomEntry(type, data);
        if (this.store) this.enqueue(() => this.saveState());
      },
      sendMessage: (message, opts) => {
        this.assertAttached();
        this.enqueue(async () => { getOrThrow(await this.lane![opts?.deliverAs === "followUp" ? "followUp" : "steer"]({
          role: "custom", customType: message.customType, content: message.content, display: message.display,
          details: message.details, timestamp: Date.now(),
        }, undefined, context)); });
      },
      sendUserMessage: (content, opts) => {
        this.assertAttached(); this.enqueue(async () => { getOrThrow(await this.lane![opts?.deliverAs ?? "steer"]({
          role: "user", content, timestamp: Date.now(),
        }, undefined, context)); });
      },
      setSessionName: name => { this.view.appendSessionInfo(name); if (this.harness) this.enqueue(() => this.harness!.setName(name, context)); },
      getSessionName: () => this.view.getSessionName(), setLabel: (id, label) => { this.assertAttached(); this.enqueue(() => this.harness!.setLabel(id, label, context)); },
      getSettings: () => this.settings.getSettings(),
      getActiveTools: () => this.activeTools,
      getAllTools: () => this.toolHost.allTools(),
      setActiveTools: names => this.toolHost.setActiveTools(names),
      refreshTools: () => this.toolHost.refresh(),
      getCommands: () => [],
      setModel: unsupported, getThinkingLevel: () => thinking, setThinkingLevel: unsupported,
    }, {
      getCallableTools: () => this.toolHost.callableTools(),
      executeTool: (id, name, args, options) => this.toolHost.executeNested(id, name, args, options),
      getModel: () => model, getScopedModels: () => [{ model, thinkingLevel: thinking }],
      isIdle: () => !this.snapshot?.operation, isProjectTrusted: () => this.options.projectTrusted,
      getSignal: () => this.abortSignal, abort: () => { this.assertAttached(); this.enqueue(async () => { getOrThrow(await this.lane!.abort(context)); }); },
      hasPendingMessages: () => (this.snapshot?.queues.length ?? 0) > 0, shutdown: () => { this.assertAttached(); this.enqueue(async () => { getOrThrow(await this.lane!.abort(context)); }); },
      getContextUsage: () => undefined, compact: unsupported, getSystemPrompt: () => this.systemPrompt,
      getSystemPromptOptions: () => ({ cwd, selectedTools: [...this.activeTools] }),
    });
    this.toolHost.refresh();
  }

  private publishTools(): void {
    if (!this.harness || !this.lane) return;
    const tools = [...this.tools];
    const active = this.activeTools.filter(name => this.toolHost.permits(name) && tools.some(tool => tool.name === name));
    this.enqueue(async () => {
      await this.harness!.setTools(tools, context);
      await this.lane!.setActiveTools(active, context);
    });
  }

  async attach(harness: AgentHarness<ExecutionToolContext>, lane: AgentLane, store: NativeTaskStore): Promise<void> {
    const watch = await lane.watch(context);
    this.harness = harness; this.lane = lane; this.store = store;
    this.snapshot = watch.snapshot;
    this.toolHost.restoreActiveTools(watch.snapshot.configuration.activeToolNames);
    this.stops.push(() => watch.unsubscribe());
    watch.start(async event => {
      if (this.closing) return;
      if (reduceLaneSnapshot(this.snapshot!, event) === "rebase") {
        try { this.snapshot = await watch.resnapshot(context); } catch (error) { if (!this.closing) this.writeError = error; }
      }
    });
    const saved = await store.session.getValue(extensionState, context);
    if (saved) {
      if (!Array.isArray(saved.value)) throw new Error("Invalid persisted child extension state");
      this.customState.length = 0;
      for (const item of saved.value) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") throw new Error("Invalid child extension state entry");
        this.customState.push([item[0], item[1]]);
      }
    } else await this.saveState();
    const refresh = async () => {
      const entries: FileEntry[] = [{ type: "session", id: store.session.metadata.id, cwd: store.binding.policy.cwd,
        version: 3, timestamp: new Date(store.session.metadata.createdAt).toISOString() }];
      for (const entry of this.snapshot!.transcript) {
        if (entry.type === "message" || entry.type === "custom") entries.push({ ...entry, timestamp: new Date(entry.timestamp).toISOString() });
      }
      this.view = SessionManager.inMemory(store.binding.policy.cwd, undefined, entries);
      for (const [type, data] of this.customState) this.view.appendCustomEntry(type, data);
    };
    await refresh();
    if (this.options.restored) {
      // Resume hooks need the saved child view and may register accepted tools before execution is admitted.
      await this.runner.emit({ type: "session_start", reason: "resume" });
      this.toolHost.refresh();
    }
    // Registration can finish between resource preparation and native attachment.
    this.publishTools();
    this.stops.push(harness.hooks.on("before_drive", async (_event, callContext) => { this.abortSignal = callContext.abortSignal; await refresh(); await this.flush(); }));
    this.stops.push(harness.hooks.on("before_run", async event => {
      const text = event.prompt.flatMap(message => "content" in message ? [typeof message.content === "string" ? message.content : extractText(message.content)] : []).join("\n");
      const result = await this.runner.emitBeforeAgentStart(text, undefined, { forceSystemPrompt: this.systemPrompt, cwd: this.options.cwd, selectedTools: this.activeTools });
      // The first native checkpoint must capture tool filtering performed by child hooks.
      await this.flush();
      this.systemPrompt = result.systemPromptOptions.forceSystemPrompt ?? this.systemPrompt;
      return result?.messages ? { messages: result.messages.map(message => ({ ...message, role: "custom" as const, timestamp: Date.now() })) } : undefined;
    }));
    this.stops.push(harness.hooks.on("transform_context", async event => { await refresh(); return { messages: await this.runner.emitContext(event.messages), systemPrompt: this.systemPrompt }; }));
    this.stops.push(harness.hooks.on("before_payload", async event => ({ payload: await this.runner.emitBeforeProviderRequest(event.payload) })));
    this.stops.push(harness.hooks.on("before_request", async event => {
      await this.flush(); return { streamOptions: { headers: Object.fromEntries(Object.entries(await this.runner.emitBeforeProviderHeaders(event.streamOptions.headers ?? {})).map(([key, value]) => [key, value ?? undefined])) } };
    }));
    this.stops.push(harness.hooks.on("after_response", async event => {
      if (event.status !== undefined) await this.runner.emit({ type: "after_provider_response", status: event.status, headers: event.headers ?? {} });
      const message = await this.runner.emitMessageEnd({ type: "message_end", message: event.message });
      return message?.role === "assistant" ? { message: message as typeof event.message } : undefined;
    }));
    this.stops.push(harness.hooks.on("before_tool", async (_event, callContext) => {
      this.abortSignal = callContext.abortSignal; await refresh(); await this.flush();
      return undefined;
    }));
    this.stops.push(harness.hooks.on("after_tool", event => this.toolHost.takeOutcome(event.toolCallId)));
    this.stops.push(harness.events.on("turn_start", async () => {
      await this.runner.emit({ type: "turn_start", turnIndex: this.snapshot!.transcript.filter(entry => entry.type === "message" && entry.message.role === "assistant").length, timestamp: Date.now() });
    }));
    await this.flush();
    for (const name of this.initialTools) {
      if (!this.toolHost.allTools().some(tool => tool.name === name) && !this.toolSources.some(grant => grant.tools === true || grant.tools.includes(name))) {
        throw new Error(`Accepted tool is unavailable: ${name}`);
      }
    }
  }

  private async buildPrompt(policy: AcceptedRunPolicy): Promise<string> {
    const { cwd, agentDir, parent, pi } = this.options;
    const env: EnvInfo = { isGitRepo: undefined, branch: null, platform: process.platform };
    try {
      const git = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
      if (git.code === 0) {
        env.isGitRepo = git.stdout.trim() === "true";
        if (env.isGitRepo) {
          const branch = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
          if (branch.code === 0) env.branch = branch.stdout.trim() || null;
        }
      } else if (git.stderr.includes("not a git repository")) env.isGitRepo = false;
    } catch {
      // Git may be absent or unavailable; directory metadata does not own task admission.
      this.options.signal?.throwIfAborted();
    }
    const extras: PromptExtras = {};
    try {
      if (policy.systemPromptMode === "inherit") extras.parentSystemPrompt = parent.getSystemPrompt();
      if (policy.systemPromptMode === "custom") {
        extras.customSystemPrompt = readFileSync(join(agentDir, "subagents-lite-prompt.md"), "utf8").trim();
        if (!extras.customSystemPrompt) this.warn("Custom prompt is empty; using the default header.");
      }
    } catch (error) { this.warn(`Prompt source is unavailable; using the default header: ${error}`); }
    if (policy.includeContextFiles) {
      try { extras.contextFiles = loadProjectContextFiles({ cwd, agentDir }).filter(file => this.options.projectTrusted || file.path.startsWith(agentDir + sep)); }
      catch (error) { this.warn(`Supplementary context files are unavailable: ${error}`); }
    }
    if (Array.isArray(policy.definition.preloadSkills)) extras.skillBlocks = preloadSkills(policy.definition.preloadSkills, cwd, this.options.projectTrusted, agentDir);
    if (Array.isArray(policy.skills)) extras.skillMetas = loadSkillMeta(policy.skills, cwd, this.options.projectTrusted, agentDir);
    else if (policy.skills === true) extras.skillMetas = this.loader.getSkills().skills.map(skill => ({
      name: skill.name, description: skill.description, location: skill.filePath, disableModelInvocation: skill.disableModelInvocation,
    }));
    return buildAgentPrompt(policy.definition, cwd, env, extras, policy.systemPromptMode);
  }

  private enqueue(action: () => Promise<unknown>): void {
    this.writes = this.writes.then(action).then(() => {}).catch(error => { this.writeError = error; });
  }
  private saveState(): Promise<void> { return this.store!.session.setValue(extensionState, [...this.customState], context); }
  async flush(): Promise<void> { await this.writes; if (this.writeError) throw this.writeError; }
  private warn(message: string): void {
    if (this.options.parent.hasUI) this.options.parent.ui.notify(`[subagents] ${message}`, "warning");
    else console.warn(`[subagents] ${message}`);
  }
  private assertOpen(): void { if (this.closed || this.closing) throw new Error("Child resources are closed"); }
  private assertAttached(): void { this.assertOpen(); if (!this.lane) throw new Error("Child execution is not attached"); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      try {
        const closing = this.toolHost.close();
        try { if (this.runner) await this.runner.emit({ type: "session_shutdown", reason: "reload" }); }
        finally { await closing; }
        await this.flush();
      } finally {
        this.closed = true;
        for (const stop of this.stops) stop();
        this.runner?.invalidate(); this.loader.getExtensions().runtime.invalidate();
        await this.settings.flush();
      }
    });
    return this.closing;
  }
}

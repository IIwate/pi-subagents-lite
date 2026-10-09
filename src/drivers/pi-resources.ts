import { readFileSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import {
  createMcpExtension, createCodemodeExtension, createToolSearchExtension,
  createBashTool, createEditTool, createFindTool, createGrepTool, createPowerShellTool, createReadTool, createWriteTool,
  DefaultPackageManager, DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  loadProjectContextFiles, type ExtensionAPI, type FileEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { AgentDoc } from "@earendil-works/pi-durable";
import { TaskDocument } from "./native-task-store.js";
import type { DurableDriver } from "./durable-driver.js";
import { Type } from "typebox";
import type { Context as ProviderContext, SimpleStreamOptions, AssistantMessage, Message, Model, ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import type { AcceptedRunPolicy } from "../agents/types.js";
import type { TaskBinding, TaskInput, ExecutionSnapshot } from "../engine/contracts.js";
import type { NativeTaskStore } from "./native-task-store.js";
import { EXCLUDED_TOOL_NAMES, resolveVisibleTools } from "../agents/agent-types.js";
import { extractText } from "../prompt/context.js";
import { buildAgentPrompt, type EnvInfo, type PromptExtras } from "../prompt/prompts.js";
import { loadSkillMeta, preloadSkills } from "../prompt/skill-loader.js";
import { PiToolHost } from "./pi-tool-host.js";
import { ObservationSink, OBS_RECALL_TOOL_NAME } from "./observation-sink.js";
import { wrapMutationWithThenRun } from "./action-fusion.js";
import type { FileLocks } from "./file-locks.js";
import type { ToolSourceGrant } from "../domain/policy.js";
import { permitsSourceTool } from "../domain/policy.js";

const GIT_EXEC_TIMEOUT_MS = 5000;
const context = BACKGROUND_CONTEXT;

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

export interface ResourceBootstrap {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  model: Model<any>;
  thinking: ThinkingLevel;
  policy?: AcceptedRunPolicy;
  restored?: TaskBinding;
  parentSystemPrompt?: string;
  inheritedState?: readonly [string, unknown][];
  observationPacking?: boolean;
  actionFusion?: boolean;
  extensionEntryPath?: string;
}

export interface ResourceHost {
  exec: ExtensionAPI["exec"];
  warn(message: string): void;
  configureModels?(models: ModelRuntime): void;
  signal?: AbortSignal;
  warnedConflicts?: Set<string>;
  /** Runtime-owned fused file queue, shared across all child sessions. Required when actionFusion is on. */
  fusedFileQueue?: FileLocks;
}

/** Owns official Pi resource factories and adapts their tool hooks to the native child. */
export class PiResources {
  private runner!: ExtensionRunner;
  private view: SessionManager;
  private driver?: DurableDriver;
  private store?: NativeTaskStore;
  private writes: Promise<void> = Promise.resolve();
  private writeError?: unknown;
  private closed = false;
  private closing?: Promise<void>;
  private snapshot?: ExecutionSnapshot;
  private abortSignal?: AbortSignal;
  private readonly stops: Array<() => void> = [];
  private readonly toolHost: PiToolHost;
  private readonly packingEnabled: boolean;
  private sink?: ObservationSink;
  private initialTools: readonly string[] = [];
  toolSources: readonly ToolSourceGrant[] = [];
  private readonly customState: Array<[string, unknown]> = [];
  get tools() { return this.toolHost.tools; }
  get activeTools() { return this.toolHost.activeTools; }
  projectRequest(request: ProviderContext): ProviderContext { return this.toolHost.projectRequest(request); }
  systemPrompt = "";
  extensionPaths: string[] = [];

  private constructor(readonly models: ModelRuntime, readonly settings: SettingsManager,
    private readonly loader: DefaultResourceLoader, private readonly options: ResourceBootstrap, private readonly host: ResourceHost) {
    this.view = SessionManager.inMemory(options.cwd);
    this.packingEnabled = options.observationPacking ?? false;
    this.toolHost = new PiToolHost({ enter: signal => { this.abortSignal = signal; }, assertOpen: () => this.assertOpen(), flush: async () => { await this.refresh(); await this.flush(); },
      changed: () => this.publishTools(), warn: message => this.warn(message),
      messages: () => this.view.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []),
    }, host.warnedConflicts);
  }

  static async open(options: ResourceBootstrap, host: ResourceHost): Promise<PiResources> {
    options = structuredClone(options);
    const { agentDir, cwd, policy, restored } = options;
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted });
    const extensionFactories = [
      { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
      { name: "codemode", factory: createCodemodeExtension({ models: false }), builtin: true, replaceable: true },
      { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    ];
    let additionalExtensionPaths = restored?.resources ? [...restored.resources.extensions] : undefined;
    if (!restored && policy?.extensions === false) {
      // Keep native tool services available without executing implicitly discovered extensions.
      const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings,
        builtinExtensions: extensionFactories.map(extension => extension.name) });
      const resolved = await packages.resolve();
      additionalExtensionPaths = resolved.extensions.filter(extension => extension.enabled && extension.path.startsWith("builtin:"))
        .map(extension => extension.path);
    }
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), signal: host.signal });
    host.configureModels?.(models);
    const allowed = Array.isArray(policy?.extensions) ? new Set(policy.extensions.map(name => name.split("/")[0])) : undefined;
    const denied = new Set(policy?.definition.excludeExtensions ?? []);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noExtensions: restored !== undefined || policy?.extensions === false,
      disabledBuiltinExtensions: policy?.definition.mcp === false ? ["mcp"] : undefined,
      extensionFactories,
      additionalExtensionPaths,
      noSkills: restored !== undefined || policy?.skills === false || Array.isArray(policy?.skills) || Array.isArray(policy?.definition.preloadSkills),
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => ({ ...result, extensions: result.extensions.filter(extension => {
        if (extension.resolvedPath === (options.extensionEntryPath ?? join(import.meta.dirname, "..", "index.ts"))) return false;
        const name = extensionName(extension.path);
        return allowed ? allowed.has(name) : !denied.has(name);
      }) }),
    });
    const resources = new PiResources(models, settings, loader, options, host);
    try {
      await loader.reload({ resolveProjectTrust: async () => options.projectTrusted });
      host.signal?.throwIfAborted();
      const loaded = loader.getExtensions();
      if (loaded.errors.length) throw new Error(loaded.errors.map(error => `${error.path}: ${error.error}`).join("\n"));
      resources.extensionPaths = loaded.extensions.map(extension => extension.resolvedPath);
      if (restored?.resources && restored.resources.extensions.some(file => !resources.extensionPaths.includes(file))) {
        throw new Error("An accepted child extension is unavailable");
      }
      resources.systemPrompt = restored?.policy.systemPrompt ?? await resources.buildPrompt(policy!);
      resources.bind();
      if (!restored) {
        resources.customState.push(...structuredClone(options.inheritedState ?? []));
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
    if (this.options.actionFusion && !this.host.fusedFileQueue) throw new Error("Action fusion requires runtime-owned file locks");
    // Fused commands route through the tool host's nested execution, so the accepted-policy
    // and active-set gates apply exactly as they would to a model-issued shell call.
    const fusionShell = {
      available: () => ["bash", "powershell"].find(name => this.toolHost.permits(name) && this.toolHost.activeTools.includes(name)),
      run: (id: string, name: string, input: { command: string; timeout?: number }, signal: AbortSignal | undefined) =>
        this.toolHost.executeNested(id, name, input, { signal }),
    };
    const mutations: AgentTool<any>[] = [createEditTool(cwd), createWriteTool(cwd)].map(tool =>
      this.options.actionFusion
        ? wrapMutationWithThenRun(tool, { cwd, queue: this.host.fusedFileQueue!, shell: fusionShell })
        : tool);
    const builtins: AgentTool<any>[] = [createReadTool(cwd), createBashTool(cwd), createPowerShellTool(cwd), ...mutations,
      createGrepTool(cwd), createFindTool(cwd)];
    for (const tool of builtins) this.toolHost.register({ definition: { ...tool, defaultActive: false,
      execute: (id, args, signal, update) => tool.execute(id, args, signal, update) },
      sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level", path: `builtin:${tool.name}` },
    }, ["read", "grep", "find"].includes(tool.name));
    // Child infrastructure: recall pages of packed large tool results. Safe to replay: reads are idempotent.
    if (this.packingEnabled) {
      this.toolHost.register({ definition: {
        name: OBS_RECALL_TOOL_NAME,
        label: "Recall Observation",
        description: "Read a stored large tool result by observation id and byte offset.",
        promptSnippet: "Recall a paged excerpt from a previously replaced large tool result",
        parameters: Type.Object({
          id: Type.String({ description: "Observation id from a placeholder" }),
          offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, default 0" })),
        }),
        defaultActive: false,
        execute: (_id: string, args: { id: string; offset?: number }) => {
          if (!this.sink) throw new Error("Observation storage is not attached");
          return this.sink.recall(args.id, args.offset);
        },
      }, sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level", path: `builtin:${OBS_RECALL_TOOL_NAME}` } }, true);
    }
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
      sendMessage: message => {
        this.assertAttached();
        this.enqueue(() => this.driver!.conversation.submit({ type: "write", entry: {
          kind: "subagents-lite.message", model: convertToLlm([{ role: "custom", ...message, timestamp: Date.now() }]),
        } }, context));
      },
      sendUserMessage: (value, opts) => {
        this.assertAttached(); this.enqueue(() => this.driver!.queue(opts?.deliverAs ?? "steer", { text: typeof value === "string" ? value : extractText(value),
          images: typeof value === "string" ? undefined : value.filter(part => part.type === "image") }));
      },
      setSessionName: name => { this.view.appendSessionInfo(name); if (this.store) this.enqueue(() => this.store!.session.commit(async tx => { (await tx.doc(TaskDocument)).name = name; }, context)); },
      getSessionName: () => this.view.getSessionName(),
      setLabel: (id, label) => { this.assertAttached(); this.enqueue(() => this.store!.session.commit(async tx => {
        const data = await tx.doc(TaskDocument); if (label === undefined) delete data.labels[id]; else data.labels[id] = label;
      }, context)); },
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
      getSignal: () => this.abortSignal, abort: () => { this.assertAttached(); this.enqueue(async () => { const operation = await this.store!.currentOperation(); if (operation) await this.driver!.requestAbort(operation.id, "agent"); }); },
      hasPendingMessages: () => (this.snapshot?.queued.length ?? 0) > 0, shutdown: () => { this.assertAttached(); this.enqueue(async () => { const operation = await this.store!.currentOperation(); if (operation) await this.driver!.requestAbort(operation.id, "agent"); }); },
      getContextUsage: () => undefined, compact: unsupported, getSystemPrompt: () => this.systemPrompt,
      getSystemPromptOptions: () => ({ cwd, selectedTools: [...this.activeTools] }),
    });
    this.toolHost.refresh();
  }

  private publishTools(): void {
    if (!this.driver) return;
    const tools = [...this.tools];
    const active = this.activeTools.filter(name => this.toolHost.permits(name) && tools.some(tool => tool.name === name));
    this.enqueue(async () => { this.driver!.installTools(tools); await this.driver!.setActiveTools(active); });
  }

  async attach(driver: DurableDriver): Promise<void> {
    this.driver = driver; this.store = driver.store;
    this.sink = this.packingEnabled && this.store.path ? new ObservationSink(`${this.store.path}.observations`) : undefined;
    if (this.packingEnabled && !this.sink) this.warn("Child session file path is unavailable; observation packing is disabled");
    const agent = await driver.harness.snapshot(AgentDoc, driver.conversation.id, context);
    this.toolHost.restoreActiveTools(Array.isArray(agent?.tools) ? agent.tools : this.initialTools);
    const saved = (await this.store.data()).extensionState;
    if (this.options.restored) {
      if (!Array.isArray(saved)) throw new Error("Invalid persisted child extension state");
      this.customState.length = 0;
      for (const item of saved) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") throw new Error("Invalid child extension state entry");
        this.customState.push([item[0], item[1]]);
      }
    } else await this.saveState();
    await this.refresh();
    this.stops.push(await driver.observe(() => {
      if (!this.closing) void this.refresh().catch(error => { if (!this.closing) this.writeError = error; });
    }));
    if (this.options.restored) {
      await this.runner.emit({ type: "session_start", reason: "resume" });
      this.toolHost.refresh();
      await this.toolHost.waitForPendingTools(10_000);
    }
    this.publishTools(); await this.flush();
    for (const name of this.initialTools) {
      if (!this.toolHost.allTools().some(tool => tool.name === name) && !this.toolSources.some(grant => permitsSourceTool(grant, name))) throw new Error(`Accepted tool is unavailable: ${name}`);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.driver || !this.store) return;
    const snapshot = await this.driver.snapshot();
    const view = await this.driver.view();
    const entries: FileEntry[] = [{ type: "session", id: this.store.binding.taskId, cwd: this.store.binding.policy.cwd, version: 3, timestamp: new Date(0).toISOString() }];
    let parentId: string | null = null;
    for (const entry of view.entries) {
      for (const [index, message] of (entry.model ?? []).entries()) {
        const id = `${entry.id}:${index}`;
        entries.push({ type: "message", id, parentId, timestamp: new Date(message.timestamp ?? 0).toISOString(), message }); parentId = id;
      }
    }
    this.view = SessionManager.inMemory(this.store.binding.policy.cwd, undefined, entries);
    for (const [type, data] of this.customState) this.view.appendCustomEntry(type, data);
    const saved = await this.store.data();
    if (typeof saved.name === "string") this.view.appendSessionInfo(saved.name);
    for (const [id, label] of Object.entries(saved.labels)) {
      if (typeof label !== "string") throw new Error("Invalid child entry label");
      this.view.appendLabelChange(id, label);
    }
    this.snapshot = snapshot;
  }
  async beforeRun(input: TaskInput): Promise<void> {
    await this.refresh(); await this.flush();
    const result = await this.runner.emitBeforeAgentStart(input.text, input.images ? [...input.images] : undefined,
      { forceSystemPrompt: this.systemPrompt, cwd: this.options.cwd, selectedTools: this.activeTools });
    this.systemPrompt = result.systemPromptOptions.forceSystemPrompt ?? this.systemPrompt;
    this.publishTools(); await this.flush();
    for (const message of result.messages ?? []) await this.driver!.conversation.commit(tx => tx.appendEntry(this.driver!.conversation.id, {
      kind: "subagents-lite.message", model: convertToLlm([{ ...message, role: "custom", timestamp: Date.now() }]),
    }), context);
  }
  async prepareContext(messages: Message[], signal?: AbortSignal): Promise<Message[]> {
    this.abortSignal = signal; await this.refresh(); await this.flush();
    await this.runner.emit({ type: "turn_start", turnIndex: this.snapshot?.stats.turnCount ?? 0, timestamp: Date.now() });
    const transformed = await this.runner.emitContext(messages as AgentMessage[]);
    return convertToLlm(this.sink ? await this.sink.project(transformed) : transformed);
  }
  async prepareStream(options?: SimpleStreamOptions): Promise<SimpleStreamOptions> {
    await this.flush();
    return { headers: await this.runner.emitBeforeProviderHeaders(options?.headers ?? {}),
      onPayload: payload => this.runner.emitBeforeProviderRequest(payload),
      onResponse: response => this.runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers }),
    };
  }
  async afterResponse(message: AssistantMessage): Promise<AssistantMessage> {
    const changed = await this.runner.emitMessageEnd({ type: "message_end", message });
    return changed?.role === "assistant" ? changed : message;
  }

  private async buildPrompt(policy: AcceptedRunPolicy): Promise<string> {
    const { cwd, agentDir } = this.options;
    const env: EnvInfo = { isGitRepo: undefined, branch: null, platform: process.platform };
    try {
      const git = await this.host.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
      if (git.code === 0) {
        env.isGitRepo = git.stdout.trim() === "true";
        if (env.isGitRepo) {
          const branch = await this.host.exec("git", ["branch", "--show-current"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
          if (branch.code === 0) env.branch = branch.stdout.trim() || null;
        }
      } else if (git.stderr.includes("not a git repository")) env.isGitRepo = false;
    } catch {
      // Git may be absent or unavailable; directory metadata does not own task admission.
      this.host.signal?.throwIfAborted();
    }
    const extras: PromptExtras = {};
    try {
      if (policy.systemPromptMode === "inherit") extras.parentSystemPrompt = this.options.parentSystemPrompt;
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
  private saveState(): Promise<void> { return this.store!.session.commit(async tx => { (await tx.doc(TaskDocument)).extensionState = JSON.parse(JSON.stringify(this.customState)); }, context); }
  async flush(): Promise<void> { await this.writes; if (this.writeError) throw this.writeError; }
  private warn(message: string): void {
    this.host.warn(message);
  }
  private assertOpen(): void { if (this.closed || this.closing) throw new Error("Child resources are closed"); }
  private assertAttached(): void { this.assertOpen(); if (!this.driver) throw new Error("Child execution is not attached"); }

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

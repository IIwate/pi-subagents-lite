import { readFileSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import {
  createBashTool, createEditTool, createFindTool, createGrepTool, createPowerShellTool, createReadTool, createWriteTool,
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  loadProjectContextFiles, type ExtensionAPI, type ExtensionContext, type FileEntry, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT, getOrThrow, reduceLaneSnapshot, value, type LaneSnapshot, type AgentHarness, type AgentLane, type AgentTool,
  type AgentHarnessTool, type ExecutionToolContext, type JsonValue } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AcceptedRunPolicy, ThinkingLevel } from "../types.js";
import type { TaskBinding } from "../engine/contracts.js";
import type { NativeTaskStore } from "./native-task-store.js";
import { EXCLUDED_TOOL_NAMES, resolveVisibleTools } from "../agents/agent-types.js";
import { extractText } from "../prompt/context.js";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.js";
import { loadSkillMeta, preloadSkills } from "../prompt/skill-loader.js";
import { GIT_EXEC_TIMEOUT_MS } from "../utils.js";

const context = BACKGROUND_CONTEXT;
const extensionState = value<unknown>("subagents-lite.v3", "extension-state");

function extensionName(file: string): string {
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
  private activeTools: string[] = [];
  private readonly definitions = new Map<string, ToolDefinition<any, any>>();
  private readonly safeTools = new Set(["read", "grep", "find"]);
  private readonly customState = new Map<string, unknown>();
  readonly tools: AgentHarnessTool<ExecutionToolContext>[] = [];
  systemPrompt = "";
  extensionPaths: string[] = [];

  private constructor(readonly models: ModelRuntime, readonly settings: SettingsManager,
    private readonly loader: DefaultResourceLoader, private readonly options: ResourceOptions) {
    this.view = SessionManager.inMemory(options.cwd);
  }

  static async open(options: ResourceOptions): Promise<PiResources> {
    const { parent, agentDir, cwd, policy, restored } = options;
    const settings = SettingsManager.create(cwd, agentDir);
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
      await loader.reload({ resolveProjectTrust: async () => restored?.resources?.trusted ?? parent.isProjectTrusted() });
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
        for (const entry of parent.sessionManager.getBranch()) {
          if (entry.type === "custom" && !entry.customType.startsWith("subagents-lite")) {
            resources.customState.set(entry.customType, structuredClone(entry.data));
          }
        }
        for (const [type, data] of resources.customState) resources.view.appendCustomEntry(type, data);
        await resources.runner.emit({ type: "session_start", reason: "new" });
      }
      resources.collectDefinitions();
      const extTools = new Map(loaded.extensions.map(extension => [extensionName(extension.path), [...extension.tools.keys()]]));
      const all = [...resources.definitions.keys()];
      resources.activeTools = restored ? [...restored.policy.tools] : resolveVisibleTools({
        activeTools: Array.isArray(policy!.tools) ? all : resources.activeTools,
        tools: policy!.tools, excludeTools: policy!.definition.excludeTools, extToolMap: extTools,
        notify: message => resources.warn(message),
      }) ?? resources.activeTools;
      for (const name of resources.activeTools) if (!resources.definitions.has(name)) throw new Error(`Accepted tool is unavailable: ${name}`);
      resources.collectTools();
      return resources;
    } catch (error) { await resources.close(); throw error; }
  }

  get toolNames(): readonly string[] { return this.activeTools; }

  private bind(): void {
    const { cwd, policy, restored, model, thinking, parent } = this.options;
    const builtins: AgentTool<any>[] = [createReadTool(cwd), createBashTool(cwd), createPowerShellTool(cwd), createEditTool(cwd),
      createWriteTool(cwd), createGrepTool(cwd), createFindTool(cwd)];
    for (const tool of builtins) this.definitions.set(tool.name, { ...tool,
      execute: (id, args, signal, update) => tool.execute(id, args, signal, update) });
    const loaded = this.loader.getExtensions();
    // The runner's synchronous session API reads a projection; only the native session persists child state.
    const view = new Proxy({} as SessionManager, { get: (_target, key) => {
      const member = Reflect.get(this.view, key, this.view);
      return typeof member === "function" ? member.bind(this.view) : member;
    } });
    this.runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, view, new ModelRegistry(this.models));
    this.stops.push(this.runner.onError(error => { this.writeError = new Error(`Child extension ${error.event}: ${error.error}`); }));
    this.activeTools = policy?.registeredTools.filter(name => !EXCLUDED_TOOL_NAMES.includes(name)) ?? [...restored!.policy.tools];
    const unsupported = () => { throw new Error("Child extensions cannot change the accepted execution policy"); };
    this.runner.bindCore({
      appendEntry: (type, data) => {
        if (this.closed) throw new Error("Child resources are closed");
        this.customState.set(type, structuredClone(data)); this.view.appendCustomEntry(type, data);
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
      getActiveTools: () => [...this.activeTools],
      getAllTools: () => [...this.definitions.values()].map(tool => ({ ...tool, sourceInfo: { source: "extension", scope: "temporary", origin: "top-level", path: cwd } })),
      setActiveTools: names => { if (this.store) unsupported(); this.activeTools = names.filter(name => !EXCLUDED_TOOL_NAMES.includes(name)); },
      refreshTools: () => { if (this.store) unsupported(); this.collectDefinitions(); }, getCommands: () => [],
      setModel: unsupported, getThinkingLevel: () => thinking, setThinkingLevel: unsupported,
    }, {
      getModel: () => model, getScopedModels: () => [{ model, thinkingLevel: thinking }],
      isIdle: () => !this.snapshot?.operation, isProjectTrusted: () => restored?.resources?.trusted ?? parent.isProjectTrusted(),
      getSignal: () => this.abortSignal, abort: () => { this.assertAttached(); this.enqueue(async () => { getOrThrow(await this.lane!.abort(context)); }); },
      hasPendingMessages: () => (this.snapshot?.queues.length ?? 0) > 0, shutdown: () => { this.assertAttached(); this.enqueue(async () => { getOrThrow(await this.lane!.abort(context)); }); },
      getContextUsage: () => undefined, compact: unsupported, getSystemPrompt: () => this.systemPrompt,
      getSystemPromptOptions: () => ({ cwd, selectedTools: [...this.activeTools] }),
    });
    this.collectDefinitions();
  }

  private collectDefinitions(): void {
    for (const tool of this.runner.getAllRegisteredTools()) {
      if (EXCLUDED_TOOL_NAMES.includes(tool.definition.name)) continue;
      this.safeTools.delete(tool.definition.name);
      this.definitions.set(tool.definition.name, tool.definition);
      if (!this.options.policy?.restrictToRegisteredTools && !this.activeTools.includes(tool.definition.name)) this.activeTools.push(tool.definition.name);
    }
  }

  private collectTools(): void {
    for (const name of this.activeTools) {
      const tool = this.definitions.get(name)!;
      this.tools.push({
      name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      executionMode: tool.executionMode, replay: this.safeTools.has(tool.name) ? "safe" : "never",
      execute: async (id, args, update, _toolContext, _invocation, callContext) => {
        this.assertOpen(); await this.flush();
        const result = await tool.execute(id, args, callContext.abortSignal, update, this.runner.createContext());
        await this.flush(); return result;
      },
      });
    }
  }

  async attach(harness: AgentHarness<ExecutionToolContext>, lane: AgentLane, store: NativeTaskStore): Promise<void> {
    this.harness = harness; this.lane = lane; this.store = store;
    const watch = await lane.watch(context);
    this.snapshot = watch.snapshot;
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
      this.customState.clear();
      for (const item of saved.value) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") throw new Error("Invalid child extension state entry");
        this.customState.set(item[0], item[1]);
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
    if (this.options.restored) await this.runner.emit({ type: "session_start", reason: "resume" });
    this.stops.push(harness.hooks.on("before_drive", async (_event, callContext) => { this.abortSignal = callContext.abortSignal; await refresh(); await this.flush(); }));
    this.stops.push(harness.hooks.on("before_run", async event => {
      const text = event.prompt.flatMap(message => "content" in message ? [typeof message.content === "string" ? message.content : extractText(message.content)] : []).join("\n");
      const result = await this.runner.emitBeforeAgentStart(text, undefined, this.systemPrompt, { cwd: this.options.cwd, selectedTools: this.activeTools });
      if (result?.systemPrompt) this.systemPrompt = result.systemPrompt;
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
    this.stops.push(harness.hooks.on("before_tool", async (event, callContext) => {
      this.abortSignal = callContext.abortSignal; await refresh();
      const result = await this.runner.emitToolCall({ type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.args });
      return result?.block ? { block: { reason: result.reason ?? "Blocked by child extension" } } : undefined;
    }));
    this.stops.push(harness.hooks.on("after_tool", async event => {
      const result = await this.runner.emitToolResult({ type: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId,
        input: event.args, content: event.content, details: event.details, isError: event.isError });
      return result ? { ...result, details: result.details as JsonValue | undefined } : undefined;
    }));
    await this.flush();
  }

  private async buildPrompt(policy: AcceptedRunPolicy): Promise<string> {
    const { cwd, agentDir, parent, pi } = this.options;
    const git = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    const branch = git.code === 0 ? await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS }) : undefined;
    const extras: PromptExtras = {};
    try {
      if (policy.systemPromptMode === "inherit") extras.parentSystemPrompt = parent.getSystemPrompt();
      if (policy.systemPromptMode === "custom") {
        extras.customSystemPrompt = readFileSync(join(agentDir, "subagents-lite-prompt.md"), "utf8").trim();
        if (!extras.customSystemPrompt) this.warn("Custom prompt is empty; using the default header.");
      }
    } catch (error) { this.warn(`Prompt source is unavailable; using the default header: ${error}`); }
    if (policy.includeContextFiles) {
      try { extras.contextFiles = loadProjectContextFiles({ cwd, agentDir }).filter(file => parent.isProjectTrusted() || file.path.startsWith(agentDir + sep)); }
      catch (error) { this.warn(`Supplementary context files are unavailable: ${error}`); }
    }
    if (Array.isArray(policy.definition.preloadSkills)) extras.skillBlocks = preloadSkills(policy.definition.preloadSkills, cwd);
    if (Array.isArray(policy.skills)) extras.skillMetas = loadSkillMeta(policy.skills, cwd);
    else if (policy.skills === true) extras.skillMetas = this.loader.getSkills().skills.map(skill => ({
      name: skill.name, description: skill.description, location: skill.filePath, disableModelInvocation: skill.disableModelInvocation,
    }));
    return buildAgentPrompt(policy.definition, cwd, { isGitRepo: git.code === 0, branch: branch?.stdout.trim() ?? null, platform: process.platform }, extras, policy.systemPromptMode);
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
        if (this.runner) await this.runner.emit({ type: "session_shutdown", reason: "reload" });
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

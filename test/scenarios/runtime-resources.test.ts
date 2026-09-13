import { existsSync, globSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Context as ProviderContext } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../src/runtime.js";
import { executeAgentTool } from "../../src/agents/tool-execution.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { PiResources } from "../../src/drivers/pi-resources.js";
import { createTestHarness, type TestHarness } from "../support/harness.js";
import { createRuntimeHost, holdRead, resultEntries, settled, spawn } from "../support/runtime.js";

describe("ExtensionRuntime child resources", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(() => harness.dispose());

  it("executes concurrent cwd tasks with independent tools, extensions, skills, and project context", async () => {
    const root = harness.createTempDir();
    const main = join(root, "main");
    const targets = [join(root, "other-repository"), join(root, "plain-directory")];
    for (const directory of [main, ...targets]) mkdirSync(directory);
    const shell = process.platform === "win32" ? "powershell" : "bash";
    const parent = await createRuntimeHost(harness, "cwd-concurrent", `tools: [read, write, ${shell}, probe/where]\nextensions: [probe]\nskills: false\npreload_skills: [task-context]`, main);
    for (const directory of [main, targets[0]]) {
      expect((await parent.api.exec("git", ["init", "--quiet"], { cwd: directory, timeout: 5000 })).code).toBe(0);
    }
    writeFileSync(join(main, "input.txt"), "Parent file");
    writeFileSync(join(main, "AGENTS.md"), "Parent project instructions");
    parent.runtime.store.mutate.agent.setIncludeContextFiles(true);
    parent.runtime.store.mutate.agent.setSystemPromptMode("inherit");
    for (const [index, directory] of targets.entries()) {
      new ProjectTrustStore(parent.directory).set(directory, true);
      mkdirSync(join(directory, ".pi", "extensions"), { recursive: true });
      mkdirSync(join(directory, ".pi", "skills", "task-context"), { recursive: true });
      writeFileSync(join(directory, "input.txt"), `Target file ${index}`);
      writeFileSync(join(directory, "AGENTS.md"), `Target instructions ${index}`);
      writeFileSync(join(directory, ".pi", "skills", "task-context", "SKILL.md"), `---\nname: task-context\ndescription: Target skill\n---\nTarget skill body ${index}`);
      writeFileSync(join(directory, ".pi", "extensions", "probe.ts"), `export default function (pi) {
        pi.registerTool({ name: "where", label: "Where", description: "Inspect the execution directory", parameters: { type: "object", properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => {
            const result = await pi.exec(process.execPath, ["-e", "process.stdout.write(process.cwd())"]);
            return { content: [{ type: "text", text: JSON.stringify({ cwd: ctx.cwd, sessionCwd: ctx.sessionManager.getCwd(), execCwd: result.stdout }) }], details: {} };
          } });
      }`);
    }
    const entered = new Set<string>();
    const together = Promise.withResolvers<void>();
    harness.onDispose(() => together.resolve());
    const requests = new Map<string, ProviderContext>();
    const respond = async (request: ProviderContext) => {
      const lines = request.systemPrompt?.split(/\r?\n/);
      const directory = targets.find(target => lines?.includes(`Working directory: ${target}`))!;
      expect(directory).toBeDefined();
      if (request.messages.some(message => message.role === "toolResult")) {
        requests.set(directory, request);
        return fauxAssistantMessage("Directory task completed");
      }
      entered.add(directory);
      if (entered.size === targets.length) together.resolve();
      await together.promise;
      return fauxAssistantMessage([
        fauxToolCall("read", { path: "input.txt" }),
        fauxToolCall("write", { path: "output.txt", content: directory }),
        fauxToolCall(shell, { command: shell === "powershell" ? "(Get-Location).ProviderPath" : "pwd -P" }),
        fauxToolCall("where", {}),
      ], { stopReason: "toolUse" });
    };
    parent.worker.setResponses(Array.from({ length: 4 }, () => respond));
    const processCwd = process.cwd();
    await Promise.all(targets.map(cwd => executeAgentTool(parent.runtime, cwd, {
      agent: "worker", prompt: "Read and write relative files, then inspect the execution directory", model: "cwd-concurrent-worker/child", cwd,
    }, undefined, undefined, parent.runtime.context)));
    expect(process.cwd()).toBe(processCwd);
    expect(entered.size).toBe(2);
    expect(existsSync(join(main, "output.txt"))).toBe(false);
    expect(readFileSync(join(main, "input.txt"), "utf8")).toBe("Parent file");
    for (const [index, directory] of targets.entries()) {
      const request = requests.get(directory)!;
      expect(readFileSync(join(directory, "output.txt"), "utf8")).toBe(directory);
      expect(request.systemPrompt).toContain(`Target instructions ${index}`);
      expect(request.systemPrompt).toContain(`Target skill body ${index}`);
      expect(request.systemPrompt).not.toContain("Parent project instructions");
      expect(request.systemPrompt).not.toContain(`Current working directory: ${main}`);
      expect(request.systemPrompt).toContain(index === 0 ? "Git repository: yes" : "Not a git repository");
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false,
        content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining(`Target file ${index}`) })]) }));
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: shell, isError: false,
        content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining(directory) })]) }));
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "where", isError: false,
        content: [{ type: "text", text: JSON.stringify({ cwd: directory, sessionCwd: directory, execCwd: directory }) }] }));
      expect(parent.runtime.engine.list().find(task => task.policy.cwd === directory)?.state).toMatchObject({ status: "settled", outcome: { status: "completed" } });
    }
    expect(parent.errors).toEqual([]);
  });

  it.each([
    { saved: true, defaultTrust: "never", trusted: true },
    { saved: false, defaultTrust: "always", trusted: false },
    { saved: undefined, defaultTrust: "always", trusted: true },
    { saved: undefined, defaultTrust: "ask", trusted: false },
  ])("loads cwd project resources with saved=$saved and default=$defaultTrust while preserving file access", async ({ saved, defaultTrust, trusted }) => {
    const parent = await createRuntimeHost(harness, "cwd-trust", "tools: [read]\nextensions: true\nskills: [target-skill, global-skill]\npreload_skills: [target-skill, global-skill]");
    const directory = harness.createTempDir();
    writeFileSync(join(parent.directory, "settings.json"), JSON.stringify({ defaultProjectTrust: defaultTrust,
      retry: { enabled: false }, compaction: { enabled: false } }));
    if (saved !== undefined) new ProjectTrustStore(parent.directory).set(directory, saved);
    mkdirSync(join(directory, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(directory, ".pi", "skills", "target-skill"), { recursive: true });
    mkdirSync(join(parent.directory, "skills", "global-skill"), { recursive: true });
    writeFileSync(join(directory, "input.txt"), "Target file remains accessible");
    writeFileSync(join(directory, "AGENTS.md"), "Target project context");
    writeFileSync(join(directory, ".pi", "skills", "target-skill", "SKILL.md"), "---\nname: target-skill\ndescription: Target skill\n---\nTarget skill body");
    writeFileSync(join(parent.directory, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: Global skill\n---\nGlobal skill body");
    writeFileSync(join(directory, ".pi", "extensions", "probe.ts"), `export default function (pi) {
      pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\\nTarget extension loaded" }));
    }`);
    parent.runtime.store.mutate.agent.setIncludeContextFiles(true);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Target inspected"); },
    ]);
    await executeAgentTool(parent.runtime, "cwd-trust", { agent: "worker", prompt: "Inspect the target", model: "cwd-trust-worker/child", cwd: directory }, undefined, undefined, parent.runtime.context);
    expect(requests[0].systemPrompt).toContain("Global skill body");
    for (const text of ["Target project context", "Target skill body", "Target extension loaded"]) {
      expect(requests[0].systemPrompt?.includes(text)).toBe(trusted);
    }
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false,
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Target file remains accessible") })]) }));
    expect(parent.errors).toEqual([]);
  });

  it("keeps an accepted cwd through queueing, alias changes, reload, and explicit resume", async () => {
    const parent = await createRuntimeHost(harness, "cwd-reload");
    const root = harness.createTempDir();
    const target = join(root, "accepted");
    const other = join(root, "other");
    const alias = join(root, "alias");
    mkdirSync(target); mkdirSync(other);
    writeFileSync(join(target, "input.txt"), "Accepted directory result");
    writeFileSync(join(other, "input.txt"), "Wrong directory result");
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    parent.runtime.store.mutate.concurrency.setDefault(1);
    const gate = holdRead(harness);
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" })]);
    await spawn(parent); await gate.entered.promise;
    await executeAgentTool(parent.runtime, "cwd-queued", { agent: "worker", prompt: "Inspect the accepted directory", model: "cwd-reload-worker/child",
      cwd: alias, run_in_background: true }, undefined, undefined, parent.runtime.context);
    const queued = parent.runtime.engine.list().at(-1)!;
    expect(queued.state.status).toBe("queued");
    expect(queued.policy.cwd).toBe(target);
    renameSync(alias, join(root, "old-alias"));
    symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
    const ctx = { ...parent.runtime.context, cwd: other };
    const closing = parent.runtime.dispose(); gate.release.resolve(); await closing;
    vi.mocked(PiResources.prototype.attach).mockRestore();
    const calls = parent.worker.state.callCount;
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.get(queued.taskId)).toMatchObject({ policy: queued.policy, operationId: queued.operationId, state: { status: "waiting" } });
    expect(parent.worker.state.callCount).toBe(calls);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Accepted cwd resumed"); },
    ]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Resumed result received")]);
    await replacement.source!.dispatch({ type: "steer", taskId: queued.taskId, operationId: queued.operationId, input: { text: "Continue" } });
    await settled(harness, replacement, queued.taskId);
    expect(requests[0].systemPrompt).toContain(`Working directory: ${target}`);
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false,
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Accepted directory result") })]) }));
    expect(parent.errors).toEqual([]);
  });

  it("rejects an invalid cwd before publishing a task and runs without Git metadata", async () => {
    const parent = await createRuntimeHost(harness, "cwd-errors");
    const directory = harness.createTempDir();
    writeFileSync(join(directory, "input.txt"), "Readable without Git");
    const parameters = { agent: "worker", prompt: "Read the file", model: "cwd-errors-worker/child" };
    await expect(executeAgentTool(parent.runtime, "invalid", { ...parameters, cwd: join(directory, "missing") }, undefined, undefined, parent.runtime.context)).rejects.toThrow("Cannot use cwd");
    expect(parent.runtime.engine.list()).toEqual([]);
    expect(parent.worker.state.callCount).toBe(0);
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(parent.api, "exec").mockRejectedValue(new Error("spawn git ENOENT"));
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Result without Git"); },
    ]);
    await executeAgentTool(parent.runtime, "cwd-valid", { ...parameters, cwd: directory }, undefined, undefined, parent.runtime.context);
    expect(requests[0].systemPrompt).toContain(`Working directory: ${directory}`);
    expect(requests[0].systemPrompt).not.toContain("Git repository:");
    expect(requests[0].systemPrompt).not.toContain("Not a git repository");
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false }));
    const task = parent.runtime.engine.list()[0];
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    renameSync(directory, `${directory}-moved`);
    harness.onDispose(() => renameSync(`${directory}-moved`, directory));
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.list()).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith("[subagents]", expect.stringContaining("Cannot use cwd"));
    const result = await executeAgentStatusTool(replacement, "status", { agent_id: task.taskId }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Result without Git");
  });

  it("restores session-start tools with saved child state before resuming a native checkpoint", async () => {
    const parent = await createRuntimeHost(harness, "resume-tools", "tools: [read, probe/ffgrep]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      pi.on("session_start", async (event, ctx) => {
        const branch = ctx.sessionManager.getBranch();
        const previous = branch.filter(entry => entry.type === "custom" && entry.customType === "probe.state").at(-1)?.data;
        const state = { reasons: [...(previous?.reasons ?? []), event.reason], hasUser: branch.some(entry => entry.type === "message" && entry.message.role === "user") };
        pi.appendEntry("probe.state", state);
        await Promise.resolve();
        pi.registerTool({ name: "ffgrep", label: "Search", description: "Inspect restored child state", parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: JSON.stringify(state) }], details: {} }) });
      });
    }`);
    parent.session.sessionManager.appendCustomEntry("probe.state", { reasons: ["parent"] });
    const gate = holdRead(harness);
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "wait" }), { stopReason: "toolUse" })]);
    const task = await spawn(parent); await gate.entered.promise;
    const ctx = parent.runtime.context;
    const closing = parent.runtime.dispose(); gate.release.resolve(); await closing;
    parent.session.sessionManager.appendCustomEntry("probe.state", { reasons: ["changed parent"] });
    const calls = parent.worker.state.callCount;
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.list()).toHaveLength(1);
    expect(replacement.engine.get(task.taskId)).toMatchObject({ operationId: task.operationId, policy: task.policy, state: { status: "waiting" } });
    expect(parent.worker.state.callCount).toBe(calls);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      request => { requests.push(request); return fauxAssistantMessage(fauxToolCall("ffgrep", {}), { stopReason: "toolUse" }); },
      request => { requests.push(request); return fauxAssistantMessage("Restored search result"); },
    ]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Restored result received")]);
    expect(await replacement.source!.dispatch({ type: "steer", taskId: task.taskId, operationId: task.operationId,
      input: { text: "Continue searching with the restored tool" } })).toMatchObject({ accepted: true });
    await settled(harness, replacement, task.taskId);
    await replacement.flushDeliveries(); await parent.session.waitForIdle();
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(["read", "ffgrep"]);
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "ffgrep", isError: false,
      content: [{ type: "text", text: JSON.stringify({ reasons: ["parent", "new", "resume"], hasUser: true }) }] }));
    expect(replacement.engine.get(task.taskId).state).toMatchObject({ status: "settled", outcome: { status: "completed", result: "Restored search result" } });
    expect(warnings).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(parent.errors).toEqual([]);
  });

  it("refreshes accepted tools after asynchronous child registration across reload", async () => {
    const parent = await createRuntimeHost(harness, "tool-refresh", "tools: [probe/mcp, probe/hidden]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      const initial = { name: "mcp", label: "MCP", description: "Cached MCP metadata", parameters: { type: "object", properties: { stale: { type: "string" } }, required: ["stale"] },
        execute: async () => ({ content: [{ type: "text", text: "Stale implementation" }], details: {} }) };
      pi.registerTool(initial);
      pi.registerTool({ ...initial, name: "hidden" });
      let connect;
      let reason;
      const connected = new Promise(resolve => { connect = resolve; });
      const initialization = connected.then(() => {
        pi.registerTool({ ...initial, description: "Connected MCP metadata: " + reason,
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          execute: async (_id, args) => ({ content: [{ type: "text", text: "Connected " + reason + ": " + args.query }], details: {} }) });
        pi.registerTool({ ...initial, name: "unapproved" });
        pi.registerTool({ ...initial, name: "Agent" });
        pi.setActiveTools([...pi.getActiveTools(), "unapproved", "write", "Agent"]);
      });
      pi.on("session_start", event => { reason = event.reason; });
      pi.on("before_agent_start", async () => {
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== "hidden"));
        connect();
        await initialization;
      });
    }`);
    const requests: ProviderContext[] = [];
    const responses = () => [
      (request: ProviderContext) => { requests.push(request); return fauxAssistantMessage(fauxToolCall("mcp", { query: "search" }), { stopReason: "toolUse" }); },
      (request: ProviderContext) => { requests.push(request); return fauxAssistantMessage("Refreshed tool result"); },
    ];
    parent.worker.setResponses(responses());
    const task = await spawn(parent, "Use connected tools", false);
    expect(task.policy.tools).toEqual(["mcp", "hidden"]);
    expect(requests[0].tools).toEqual([expect.objectContaining({ name: "mcp", description: "Connected MCP metadata: new",
      parameters: expect.objectContaining({ required: ["query"] }) })]);
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "mcp", isError: false,
      content: [{ type: "text", text: "Connected new: search" }] }));
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    parent.worker.setResponses(responses());
    await replacement.engine.continue(task.taskId, { text: "Use refreshed tools after reload" });
    await replacement.engine.wait(task.taskId);
    expect(replacement.engine.get(task.taskId).policy.tools).toEqual(task.policy.tools);
    expect(requests[2].tools).toEqual([expect.objectContaining({ name: "mcp", description: "Connected MCP metadata: resume" })]);
    expect(requests[3].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "mcp", isError: false,
      content: [{ type: "text", text: "Connected resume: search" }] }));
    expect(requests.map(request => request.tools?.map(tool => tool.name))).toEqual([["mcp"], ["mcp"], ["mcp"], ["mcp"]]);
    expect(warnings).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(parent.errors).toEqual([]);
  });

  it("adapts child extension hooks and state while keeping durable results readable without the extension", async () => {
    const parent = await createRuntimeHost(harness, "resources", "tools: [probe/inspect]\nextensions: [probe]\nskills: false");
    mkdirSync(join(parent.directory, "extensions"));
    const extension = join(parent.directory, "extensions", "probe.ts");
    writeFileSync(extension, `export default function (pi) {
      pi.on("session_start", () => pi.registerTool({
        name: "inspect", label: "Inspect", description: "Inspect child state", parameters: { type: "object", properties: {} },
        execute: async (_id, _args, _signal, _update, ctx) => {
          const state = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "probe.state").at(-1).data;
          state.count++;
          pi.appendEntry("probe.state", state);
          return { content: [{ type: "text", text: JSON.stringify({ count: state.count, cwd: ctx.cwd, ui: ctx.hasUI }) }], details: {} };
        }
      }));
      pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\\nChild hook applied" }));
      pi.on("session_shutdown", () => pi.appendEntry("probe.shutdown", { saved: true }));
    }`);
    parent.session.sessionManager.appendCustomEntry("probe.state", { count: 4 });
    const requests: string[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }),
      request => { requests.push(JSON.stringify(request)); return fauxAssistantMessage("Persistent resource result"); },
    ]);
    const task = await spawn(parent, "Inspect isolated resources", false);
    expect(requests[0]).toContain("Child hook applied");
    expect(requests[0]).toContain('\\"count\\":5');
    expect(requests[0]).toContain('\\"ui\\":false');
    expect(parent.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "probe.state").at(-1)).toMatchObject({ data: { count: 4 } });
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const taskRoot = join(parent.directory, "subagents-lite-v3", "sessions");
    const [taskFile] = globSync("**/*.jsonl", { cwd: taskRoot });
    expect(readFileSync(join(taskRoot, taskFile), "utf8")).toContain("probe.shutdown");
    unlinkSync(extension);
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.list()).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith("[subagents]", expect.stringContaining("Extension path does not exist"));
    const result = await executeAgentStatusTool(replacement, "status", { agent_id: task.taskId }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Persistent resource result");
  });

  it("filters child tools within the accepted ceiling before requests and restores the saved subset", async () => {
    const parent = await createRuntimeHost(harness, "tool-filter", "tools: [read, probe/ask_user_question]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "input.txt"), "Readable without UI");
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      pi.registerTool({ name: "ask_user_question", label: "Ask", description: "Ask through the UI", parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "Question asked" }], details: {} }) });
      pi.on("before_agent_start", (_event, ctx) => {
        const active = pi.getActiveTools();
        if (!ctx.hasUI) pi.setActiveTools(active.filter(name => name !== "ask_user_question"));
        pi.setActiveTools([...pi.getActiveTools(), "write", "Agent", "unknown_tool"]);
      });
    }`);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      request => { requests.push(request); return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }); },
      request => { requests.push(request); return fauxAssistantMessage("Filtered child result"); },
    ]);
    const task = await spawn(parent, "Read the file", false);
    expect(requests.map(request => request.tools?.map(tool => tool.name))).toEqual([["read"], ["read"]]);
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false,
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Readable without UI") })]) }));
    expect(task.policy.tools).toEqual(["read", "ask_user_question"]);
    const ctx = parent.runtime.context;
    await parent.runtime.dispose();
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(ctx);
    expect(replacement.engine.get(task.taskId).policy.tools).toEqual(task.policy.tools);
    parent.worker.setResponses([request => { requests.push(request); return fauxAssistantMessage("Restored filtered result"); }]);
    await replacement.engine.continue(task.taskId, { text: "Continue with the filtered tools" });
    await replacement.engine.wait(task.taskId);
    expect(requests.at(-1)!.tools?.map(tool => tool.name)).toEqual(["read"]);
    expect(warnings).not.toHaveBeenCalled();
    expect(parent.errors).toEqual([]);
  });

  it("reports child hook failures while preserving tool execution and durable delivery", async () => {
    const parent = await createRuntimeHost(harness, "hook-errors", "tools: [read]\nextensions: [probe]\nskills: false");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "input.txt"), "Read after a hook failure");
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      pi.on("before_agent_start", () => { throw new Error("Optional startup hook failed"); });
      pi.on("tool_result", () => { throw new Error("Optional result hook failed"); });
    }`);
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Result after child hook errors"); },
    ]);
    parent.parentProvider.setResponses([fauxAssistantMessage("Child result received")]);
    const task = await spawn(parent); await settled(harness, parent.runtime, task.taskId);
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "read", isError: false }));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Optional startup hook failed"));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Optional result hook failed"));
    expect(resultEntries(parent)).toHaveLength(1);
    expect(readFileSync(parent.session.sessionManager.getSessionFile()!, "utf8")).toContain("Result after child hook errors");
    expect(parent.errors).toEqual([]);
  });

  it("keeps child state write failures fatal to tool execution and resource flushing", async () => {
    const parent = await createRuntimeHost(harness, "write-error", "tools: [probe/inspect]\nextensions: [probe]\nskills: false");
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function (pi) {
        pi.on("before_agent_start", () => pi.appendEntry("probe.state", { count: 1 }));
        pi.registerTool({ name: "inspect", label: "Inspect", description: "Record a tool effect", parameters: { type: "object", properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => {
            writeFileSync(join(ctx.cwd, "executed.txt"), "Tool executed");
            return { content: [{ type: "text", text: "Tool executed" }], details: {} };
          } });
      }`);
    const writeFailure = new Error("Child state persistence failed");
    const attach = PiResources.prototype.attach;
    vi.spyOn(PiResources.prototype, "attach").mockImplementation(async function (this: PiResources, childHarness, lane, store) {
      await attach.call(this, childHarness, lane, store);
      vi.spyOn(store.session, "setValue").mockRejectedValue(writeFailure);
    });
    const requests: ProviderContext[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage("Tool execution was blocked"); },
    ]);
    await spawn(parent, "Attempt the tool after saving state", false);
    expect(requests[0].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "inspect", isError: true,
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining(writeFailure.message) })]) }));
    expect(existsSync(join(parent.directory, "executed.txt"))).toBe(false);
    await expect(parent.runtime.dispose()).rejects.toThrow("cleanup failed");
  });
});

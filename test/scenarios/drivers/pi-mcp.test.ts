import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type Context } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../../src/runtime.js";
import { executeAgentTool } from "../../../src/agents/tool-execution.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { createRuntimeHost } from "../../support/runtime.js";

describe("Native Pi MCP child tools", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(() => harness.dispose());

  async function host(exposure = "codemode") {
    const parent = await createRuntimeHost(harness, "native-mcp");
    vi.stubEnv("PI_CODING_AGENT_DIR", parent.directory);
    parent.runtime.store.mutate.routing.configureAgentProviderAccess("general-purpose", parent.worker.provider.id);
    const server = join(parent.directory, "server.mjs");
    writeFileSync(server, `import { createInterface } from "node:readline";
      const tools = [{ name: "lookup", description: "Look up a document", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
      createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result;
        if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "offline", version: "1" } };
        else if (request.method === "tools/list") result = { tools };
        else if (request.method === "tools/call") result = { content: [{ type: "text", text: "Document: " + request.params.arguments.query }], structuredContent: { value: 42 }, isError: request.params.arguments.query === "fail" };
        else if (request.method === "resources/list") result = { resources: [{ uri: "test://document", name: "Document" }] };
        else if (request.method === "resources/templates/list") result = { resourceTemplates: [] };
        else if (request.method === "resources/read") result = { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "Offline resource" }] };
        else result = {};
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      });`);
    writeFileSync(join(parent.directory, "mcp.json"), JSON.stringify({ mcpServers: {
      docs: { command: process.execPath, args: [server], exposure },
    } }));
    return parent;
  }

  async function run(parent: Awaited<ReturnType<typeof host>>, runtime = parent.runtime) {
    await executeAgentTool(runtime, "native-call", { agent: "general-purpose", prompt: "Use the document service",
      model: `${parent.worker.provider.id}/child` }, undefined, undefined, runtime.context);
    return runtime.engine.list().at(-1)!;
  }

  it("loads the default MCP codemode path, preserves structured errors, and records child nested calls", async () => {
    const parent = await host();
    const requests: Context[] = [];
    parent.worker.setResponses([
      request => {
        requests.push(request);
        return fauxAssistantMessage(fauxToolCall("codemode", { code: `const r = await tools.mcp__docs__lookup({ query: "fail" }); store("answer", r.structuredContent.value); text({ value: r.structuredContent.value, error: r.isError });` }), { stopReason: "toolUse" });
      },
      request => { requests.push(request); return fauxAssistantMessage(fauxToolCall("codemode", { code: `store("other", true); text(load("answer"));` }), { stopReason: "toolUse" }); },
      request => { requests.push(request); return fauxAssistantMessage("Service result inspected"); },
    ]);
    const task = await run(parent);
    expect(task.state).toMatchObject({ status: "settled", outcome: { status: "completed" } });
    const names = getCurrentTools(requests[0].messages).map(tool => tool.name);
    expect(names).toContain("codemode");
    expect(names).not.toContain("mcp__docs__lookup");
    expect(names).not.toContain("Agent");
    const result = requests[1].messages.find(message => message.role === "toolResult");
    expect(result).toMatchObject({ isError: false, details: { nestedCalls: { complete: true,
      calls: [expect.objectContaining({ name: "mcp__docs__lookup", status: "error" })] } } });
    expect(JSON.stringify(result)).toContain('\\"value\\":42');
    expect(JSON.stringify(result)).toContain('\\"error\\":true');
    expect(JSON.stringify(requests[2].messages.at(-1))).toContain("42");
    expect(parent.errors).toEqual([]);
  });

  it("cancels one HTTP MCP request while another child continues using the server", async () => {
    const parent = await host("direct");
    const entered = Promise.withResolvers<void>();
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of request) body += chunk;
      const call = JSON.parse(body);
      if (call.id === undefined) { response.writeHead(202).end(); return; }
      let result: unknown = {};
      if (call.method === "initialize") result = { protocolVersion: call.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shared", version: "1" } };
      if (call.method === "tools/list") result = { tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] };
      if (call.method === "tools/call") {
        if (call.params.arguments.query === "wait") { entered.resolve(); return; }
        result = { content: [{ type: "text", text: "Second child result" }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
    harness.onDispose(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    writeFileSync(join(parent.directory, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: `http://127.0.0.1:${address.port}/mcp`, exposure: "direct" } } }));
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__docs__lookup", { query: "wait" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("mcp__docs__lookup", { query: "ready" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Second child completed"),
    ]);
    const params = { agent: "general-purpose", prompt: "Wait for the service", model: `${parent.worker.provider.id}/child`, run_in_background: true };
    await executeAgentTool(parent.runtime, "waiting", params, undefined, undefined, parent.runtime.context);
    const first = parent.runtime.engine.list().at(-1)!;
    await entered.promise;
    const second = await run(parent);
    expect(second.state).toMatchObject({ status: "settled", outcome: { status: "completed" } });
    await parent.runtime.engine.requestAbort(first.taskId, "user");
    await parent.runtime.engine.wait(first.taskId);
    expect(parent.runtime.engine.get(first.taskId).state).toMatchObject({ status: "settled", outcome: { status: "stopped" } });
    parent.worker.setResponses([fauxAssistantMessage(fauxToolCall("mcp__docs__lookup", { query: "again" }), { stopReason: "toolUse" }), fauxAssistantMessage("Server still usable")]);
    await parent.runtime.engine.continue(second.taskId, { text: "Read once more" });
    await parent.runtime.engine.wait(second.taskId);
    expect(parent.runtime.engine.get(second.taskId).state).toMatchObject({ status: "settled", outcome: { result: "Server still usable" } });
    expect(parent.errors).toEqual([]);
  });

  it("discovers deferred tools on the child branch and restores their activation", async () => {
    const parent = await host("deferred");
    const requests: Context[] = [];
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "lookup document" }), { stopReason: "toolUse" }),
      request => { requests.push(request); return fauxAssistantMessage(fauxToolCall("mcp__docs__lookup", { query: "fail" }), { stopReason: "toolUse" }); },
      request => { requests.push(request); return fauxAssistantMessage("Failure inspected"); },
    ]);
    const task = await run(parent);
    expect(getCurrentTools(requests[0].messages).map(tool => tool.name)).toContain("mcp__docs__lookup");
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "mcp__docs__lookup", isError: true }));
    const context = parent.runtime.context;
    await parent.runtime.dispose();
    const replacement = new ExtensionRuntime(parent.api, { agentDir: parent.directory });
    harness.onDispose(() => replacement.dispose());
    await replacement.start(context);
    parent.worker.setResponses([
      request => { requests.push(request); return fauxAssistantMessage(fauxToolCall("mcp__docs__lookup", { query: "resume" }), { stopReason: "toolUse" }); },
      fauxAssistantMessage("Restored service used"),
    ]);
    await replacement.engine.continue(task.taskId, { text: "Use the previously discovered tool" });
    await replacement.engine.wait(task.taskId);
    expect(getCurrentTools(requests[2].messages).map(tool => tool.name)).toContain("mcp__docs__lookup");
    expect(parent.session.getActiveToolNames()).not.toContain("mcp__docs__lookup");
    expect(parent.errors).toEqual([]);
  });

  it("enforces source allowlists and result redaction inside third-party orchestration", async () => {
    const parent = await createRuntimeHost(harness, "nested-policy", "tools: [probe/compose, probe/data, probe/redacted]\nextensions: [probe]\nskills: false");
    mkdirSync(join(parent.directory, "extensions"));
    writeFileSync(join(parent.directory, "extensions", "probe.ts"), `export default function (pi) {
      const parameters = { type: "object", properties: {} };
      for (const name of ["data", "redacted", "denied", "Agent"]) pi.registerTool({ name, label: name, description: name, parameters, exposure: "deferred",
        outputSchema: { type: "object" }, execute: async () => ({ content: [{ type: "text", text: "Private value" }], structuredContent: { secret: true }, details: {} }) });
      pi.on("tool_result", event => event.toolName === "redacted" ? { content: [{ type: "text", text: "Redacted" }] } : undefined);
      pi.registerTool({ name: "compose", label: "Compose", description: "Invoke child tools", parameters,
        execute: async (_id, _args, signal, _update, ctx) => {
          const names = ctx.tools.map(tool => tool.name);
          const results = await Promise.all(["data", "redacted", "denied", "Agent"].map(name => ctx.executeTool(name, {}, { signal })));
          return { content: [{ type: "text", text: JSON.stringify({ names, results }) }], details: {} };
        } });
    }`);
    let request!: Context;
    parent.worker.setResponses([
      fauxAssistantMessage(fauxToolCall("compose", {}), { stopReason: "toolUse" }),
      context => { request = context; return fauxAssistantMessage("Policy inspected"); },
    ]);
    await executeAgentTool(parent.runtime, "compose-call", { agent: "worker", prompt: "Check child tool policy", model: `${parent.worker.provider.id}/child` }, undefined, undefined, parent.runtime.context);
    const result = request.messages.find(message => message.role === "toolResult")!;
    expect(result.role).toBe("toolResult");
    const body = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}");
    expect(body.names).not.toContain("denied");
    expect(body.names).not.toContain("Agent");
    expect(body.results.map((outcome: { isError: boolean }) => outcome.isError)).toEqual([false, false, true, true]);
    expect(body.results[0].result.structuredContent).toEqual({ secret: true });
    expect(body.results[1].result.structuredContent).toBeUndefined();
    expect(parent.errors).toEqual([]);
  });
});

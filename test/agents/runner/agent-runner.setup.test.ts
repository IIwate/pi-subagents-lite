import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_PROMPT_PATH } from "../../../src/config/config-io.js";
import { ctx, pi, policy, run, runner, session, message } from "./runner-test-helpers.js";
import { makeResolvablePromise } from "../../fixtures.js";

describe("runner setup", () => {
  it.each([
    { fault: "output_blocked" as const, error: "content was flagged" },
    { fault: "provider_error" as const, error: "provider error after session setup" },
  ])("injects $fault only after session setup", async ({ fault, error }) => {
    const onSessionCreated = vi.fn();
    await expect(run({ debugFault: fault, onSessionCreated })).rejects.toThrow(error);
    expect(onSessionCreated).toHaveBeenCalledWith(session);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("copies extension state without inheriting parent delivery records or mutable data", async () => {
    const nested = { enabled: true, nested: { value: 1 } };
    ctx.sessionManager = { getBranch: () => [
      { type: "custom", customType: "settings", data: { enabled: false } },
      { type: "custom", customType: "other", data: { value: 2 } },
      { type: "custom", customType: "subagents-lite:pending-result", data: { deliveryId: "pending" } },
      { type: "custom", customType: "subagents-lite:result-ack", data: { deliveryIds: ["pending"] } },
      { type: "custom", customType: "settings", data: nested },
    ] };
    await run();
    const entries = runner.createSession.mock.calls[0][0].sessionManager.getEntries();
    expect(entries.map((entry: { customType: string }) => entry.customType)).toEqual(["other", "settings"]);
    expect(entries[1].data).toEqual(nested);
    entries[1].data.nested.value = 7;
    expect(nested.nested.value).toBe(1);
  });

  it("disposes setup when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run({ signal: controller.signal })).rejects.toThrow("Agent session setup aborted");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("uses the accepted alternate model and scope even if the parent model is absent", async () => {
    const model = { ...ctx.model, provider: "other", id: "accepted" };
    const scopedModels = [{ model, thinkingLevel: "low" as const }];
    ctx.model = undefined;
    ctx.scopedModels = [];
    await run({ model, scopedModels, thinkingLevel: "off" });
    expect(runner.createSession).toHaveBeenCalledWith(expect.objectContaining({ model, scopedModels, thinkingLevel: "off" }));
  });

  it("rejects a run without an invocation or parent model", async () => {
    ctx.model = undefined;
    await expect(run()).rejects.toThrow(/model/i);
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it.each([undefined, "off", "high"] as const)("passes the accepted thinking level unchanged: %s", async thinkingLevel => {
    await run({ thinkingLevel });
    expect(runner.createSession.mock.calls[0][0].thinkingLevel).toBe(thinkingLevel);
  });

  it.each([undefined, 0, 512])("applies maxTokens without mutating the source model: %s", async maxTokens => {
    const original = { ...ctx.model, maxTokens: 4096 };
    ctx.model = original;
    await run({ acceptedPolicy: policy({ definition: { name: "test-agent", description: "", systemPrompt: "", maxTokens } }) });
    expect(runner.createSession.mock.calls[0][0].model.maxTokens).toBe(maxTokens || 4096);
    expect(original.maxTokens).toBe(4096);
  });

  it.each([true, false])("loads project context only when enabled: %s", async includeContextFiles => {
    runner.contextFiles.mockReturnValue([{ path: "AGENTS.md", content: "Instructions" }]);
    await run({ acceptedPolicy: policy({ includeContextFiles }) });
    expect(runner.contextFiles).toHaveBeenCalledTimes(includeContextFiles ? 1 : 0);
    const extras = runner.prompt.mock.calls[0][3];
    if (includeContextFiles) expect(extras).toMatchObject({ contextFiles: [{ path: "AGENTS.md", content: "Instructions" }] });
    else expect(extras).not.toHaveProperty("contextFiles");
  });

  it("continues when context-file loading fails", async () => {
    runner.contextFiles.mockImplementation(() => { throw new Error("unreadable context"); });
    await expect(run()).resolves.toMatchObject({ responseText: "Done" });
  });

  it("uses the accepted prompt mode", async () => {
    ctx.getSystemPrompt = vi.fn(() => "Parent instructions");
    await run({ acceptedPolicy: policy({ systemPromptMode: "inherit" }) });
    expect(ctx.getSystemPrompt).toHaveBeenCalledOnce();
    expect(runner.prompt).toHaveBeenCalledWith(expect.anything(), ctx.cwd, expect.anything(),
      expect.objectContaining({ parentSystemPrompt: "Parent instructions" }), "inherit");
  });

  it("contains a parent prompt lookup failure", async () => {
    ctx.getSystemPrompt = () => { throw new Error("parent unavailable"); };
    await expect(run({ acceptedPolicy: policy({ systemPromptMode: "inherit" }) })).resolves.toMatchObject({ responseText: "Done" });
  });

  it.each(["Custom instructions", "", "ENOENT", "EACCES"])("handles a custom prompt source: %s", async content => {
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
      if (String(file) !== CUSTOM_PROMPT_PATH) return read(file, ...args as [any]);
      if (content === "ENOENT" || content === "EACCES") throw Object.assign(new Error(content), { code: content });
      return content;
    });
    await expect(run({ acceptedPolicy: policy({ systemPromptMode: "custom" }) })).resolves.toMatchObject({ responseText: "Done" });
    if (content === "Custom instructions") expect(runner.prompt.mock.calls[0][3]).toMatchObject({ customSystemPrompt: content });
    else expect(runner.prompt.mock.calls[0][3]).not.toHaveProperty("customSystemPrompt");
  });

  it("holds resolver warnings until the child prompt has completed", async () => {
    let running = false;
    const notify = vi.fn(() => { expect(running).toBe(false); });
    ctx.ui = { notify };
    pi.sendMessage = vi.fn();
    session.prompt.mockImplementation(async () => {
      running = true;
      expect(notify).not.toHaveBeenCalled();
      running = false;
      session.emit({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop",
      } as any });
    });
    await run({ acceptedPolicy: policy({ definition: { name: "test-agent", description: "", systemPrompt: "", tools: ["read"], excludeTools: ["write"] }, tools: ["read"] }) });
    expect(notify).toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("buffers console warnings until completion when the parent has no UI", async () => {
    const finish = makeResolvablePromise();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session.prompt.mockImplementation(async () => {
      await finish.promise;
      session.emit({ type: "message_end", message: message() });
    });
    const running = run({ acceptedPolicy: policy({
      definition: { name: "test-agent", description: "Test", systemPrompt: "Instructions", tools: ["read"], excludeTools: ["write"] },
      tools: ["read"],
    }) });
    try {
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
      expect(warn).not.toHaveBeenCalled();
    } finally {
      finish.resolve(undefined);
      await running;
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("both tools and exclude_tools set"));
  });
});

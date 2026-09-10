import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeResolvablePromise } from "../../../support/fixtures.js";
import { closeSession, ctx, harness, policy, run, runner, session } from "../../../support/runner.js";

describe("runner tool and extension boundaries", () => {
  it("disposes setup aborted during extension binding", async () => {
    const binding = makeResolvablePromise();
    const started = makeResolvablePromise();
    const closed = makeResolvablePromise();
    harness.onDispose(() => binding.resolve(undefined));
    session.bindExtensions.mockImplementation(() => {
      started.resolve(undefined);
      return binding.promise;
    });
    closeSession.mockImplementation(async () => {
      session.dispose();
      closed.resolve(undefined);
    });
    const controller = new AbortController();
    const running = run({ signal: controller.signal });
    const rejected = expect(running).rejects.toThrow("Agent session setup aborted");
    await started.promise;
    controller.abort();
    await closed.promise;
    binding.resolve(undefined);
    await rejected;
    expect(closeSession).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it.each(["setSessionName", "bindExtensions", "getAllTools", "setActiveToolsByName", "onSessionCreated"] as const)(
    "closes a created session when %s fails without replacing the setup error", async stage => {
      const failure = new Error(`Setup failed at ${stage}`);
      const fail = () => { throw failure; };
      if (stage !== "onSessionCreated") session[stage].mockImplementationOnce(fail);
      const onSessionCreated = stage === "onSessionCreated" ? vi.fn(fail) : vi.fn();
      await expect(run({ acceptedPolicy: policy({ tools: ["read"] }), onSessionCreated })).rejects.toBe(failure);
      expect(closeSession).toHaveBeenCalledExactlyOnceWith(session);
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(session.prompt).not.toHaveBeenCalled();
      if (stage !== "onSessionCreated") expect(onSessionCreated).not.toHaveBeenCalled();
    },
  );

  it("preserves the setup error when cleanup also rejects", async () => {
    const failure = new Error("Extension binding failed");
    session.bindExtensions.mockRejectedValueOnce(failure);
    closeSession.mockRejectedValueOnce(new Error("Shutdown failed"));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run()).rejects.toBe(failure);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("Shutdown failed"));
  });

  it("closes a session created after cancellation without making it interactive", async () => {
    const created = makeResolvablePromise();
    const started = makeResolvablePromise();
    const controller = new AbortController();
    harness.onDispose(() => created.resolve({ session }));
    runner.createSession.mockImplementationOnce(() => {
      started.resolve(undefined);
      return created.promise;
    });
    const onSessionCreated = vi.fn();
    const running = run({ signal: controller.signal, onSessionCreated });
    const rejected = expect(running).rejects.toThrow("Agent session setup aborted");
    await started.promise;
    controller.abort();
    created.resolve({ session });
    await rejected;
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("passes an explicit registered tool boundary to Pi", async () => {
    await run({ acceptedPolicy: policy({ registeredTools: ["read", "bash"], restrictToRegisteredTools: true }) });
    expect(runner.createSession.mock.calls[0][0].tools).toEqual(["read", "bash"]);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("disables tools when the accepted policy requests none", async () => {
    await run({ acceptedPolicy: policy({ tools: false }) });
    expect(runner.createSession.mock.calls[0][0].tools).toEqual([]);
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([]);
  });

  it("applies visibility after extensions finish registering their tools", async () => {
    const tools = new Map<string, unknown>([["web_search", {}]]);
    runner.extensions = [{ path: join(runner.agentDir, "extensions", "tavily", "index.ts"), tools }];
    session.bindExtensions.mockImplementation(async () => {
      tools.set("web_extract", {});
      session.getAllTools.mockReturnValue(["read", "web_search", "web_extract", "Agent"].map(name => ({ name })));
    });
    await run({ acceptedPolicy: policy({ tools: ["read", "tavily/*"], extensions: ["tavily"] }) });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "web_search", "web_extract"]);
  });

  it.each([
    { extensions: ["tavily"], exclude: undefined, expected: ["tavily"] },
    { extensions: ["tavily/web_search"], exclude: undefined, expected: ["tavily"] },
    { extensions: true, exclude: ["tavily"], expected: ["other"] },
    { extensions: ["tavily"], exclude: ["tavily"], expected: ["tavily"] },
  ])("applies extension selection through the resource loader: $expected", async ({ extensions, exclude, expected }) => {
    await run({ acceptedPolicy: policy({ extensions, definition: { name: "test-agent", description: "", systemPrompt: "", excludeExtensions: exclude } }) });
    const extensionsOverride = runner.loaderOptions[0].extensionsOverride!;
    const entries = ["tavily", "other"].map(name => ({ name, path: join(runner.agentDir, "extensions", name, "index.ts") }));
    const selected = extensionsOverride({ extensions: entries, errors: [], runtime: {} } as any);
    expect(selected.extensions.map((extension: any) => (extension as unknown as { name: string }).name)).toEqual(expected);
  });

  it.each([true, false])("sets extension loading without an unnecessary filter: %s", async extensions => {
    await run({ acceptedPolicy: policy({ extensions }) });
    expect(runner.loaderOptions[0].noExtensions).toBe(!extensions);
    expect(runner.loaderOptions[0].extensionsOverride).toBeUndefined();
  });

  it("preserves an explicit PowerShell tool snapshot", async () => {
    session.getActiveToolNames.mockReturnValue(["read", "powershell", "edit", "write"]);
    await run({ acceptedPolicy: policy({ registeredTools: ["read", "powershell", "edit", "write"] }) });
    expect(session.getActiveToolNames()).toContain("powershell");
    expect(session.getActiveToolNames()).not.toContain("bash");
  });

  it("honors a PowerShell exclusion during Windows Bash substitution", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    runner.bashAvailable = false;
    await run({ acceptedPolicy: policy({ definition: { name: "test-agent", description: "", systemPrompt: "", excludeTools: ["powershell"] } }) });
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(["read", "edit"]);
    expect(runner.createSession.mock.calls[0][0].cwd).toBe(ctx.cwd);
  });
});

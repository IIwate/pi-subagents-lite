import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeResolvablePromise } from "../../fixtures.js";
import { ctx, policy, run, runner, session } from "./runner-test-helpers.js";

describe("runner tool and extension boundaries", () => {
  it("disposes setup aborted during extension binding", async () => {
    const binding = makeResolvablePromise();
    session.bindExtensions.mockReturnValue(binding.promise);
    const controller = new AbortController();
    const running = run({ signal: controller.signal });
    await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledOnce());
    controller.abort();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
    binding.resolve(undefined);
    await expect(running).rejects.toThrow("Agent session setup aborted");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("passes an explicit registered tool boundary to Pi", async () => {
    await run({ acceptedPolicy: policy({ registeredTools: ["read", "bash"], restrictToRegisteredTools: true }) });
    expect(runner.createSession.mock.calls[0][0].tools).toEqual(["read", "bash"]);
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

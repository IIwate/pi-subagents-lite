import { describe, expect, it, vi } from "vitest";
import { continueAgentSession } from "../../../../src/agents/agent-runner.js";
import { asSession, message, session } from "../../../support/runner.js";

describe("runner outcomes", () => {
  it("returns text and forwards images through an existing session", async () => {
    const images = [{ type: "image" as const, mimeType: "image/png", data: "encoded-image" }];
    const result = await continueAgentSession(asSession(session), "Continue", { images });
    expect(result).toMatchObject({ responseText: "Done", aborted: false, turnLimited: false });
    expect(session.prompt).toHaveBeenCalledWith("Continue", { images });
  });

  it.each([
    { content: [] },
    { content: [{ type: "thinking" as const, thinking: "Working" }] },
  ])("rejects an empty completed response: $content", async ({ content }) => {
    session.prompt.mockImplementation(async () => { session.emit({ type: "message_end", message: message(content) }); });
    await expect(continueAgentSession(asSession(session), "Continue")).rejects.toThrow();
  });

  it.each([
    "call:sample_namespace:sample_tool{value:example}",
    "call:other_scope:other-tool_2{value:example}",
    "call:sample_scope:nested_scope:tool.v2{}",
    ' \ncall:sample_tool {\n  "value": "example"\n}\n ',
  ])("rejects a terminal unexecuted tool invocation: %s", async text => {
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "message_end", message: message([{ type: "text", text }]) });
    });
    await expect(continueAgentSession(asSession(session), "Continue"))
      .rejects.toThrow("Subagent emitted unexecuted tool call text");
  });

  it.each([
    "The model emitted `call:sample_namespace:sample_tool{value:example}` as text.",
    "```text\ncall:sample_namespace:sample_tool{value:example}\n```",
  ])("preserves an explanation quoting a tool invocation: %s", async text => {
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "message_end", message: message([{ type: "text", text }]) });
    });
    expect((await continueAgentSession(asSession(session), "Continue")).responseText).toBe(text);
  });

  it.each(["quota exhausted", "invalid API key", "content_filter"])("preserves provider failures: %s", async errorMessage => {
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "message_end", message: message([], { stopReason: "error", errorMessage }) });
    });
    await expect(continueAgentSession(asSession(session), "Continue")).rejects.toThrow(errorMessage);
  });

  it.each(["", "call:sample_namespace:sample_tool{value:example}"])("preserves interrupted output: %j", async text => {
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "message_end", message: message([{ type: "text", text }], { stopReason: "aborted" }) });
    });
    expect((await continueAgentSession(asSession(session), "Continue")).aborted).toBe(true);
  });

  it("releases callback subscriptions after a failed prompt", async () => {
    const onAssistantUsage = vi.fn();
    session.prompt.mockRejectedValue(new Error("prompt failed"));
    await expect(continueAgentSession(asSession(session), "Continue", { onAssistantUsage })).rejects.toThrow("prompt failed");
    session.emit({ type: "message_end", message: message() });
    expect(onAssistantUsage).not.toHaveBeenCalled();
  });
});

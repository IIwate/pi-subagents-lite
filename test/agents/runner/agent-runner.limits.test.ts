import { describe, expect, it } from "vitest";
import { continueAgentSession } from "../../../src/agents/agent-runner.js";
import { asSession, message, session } from "./runner-test-helpers.js";

describe("runner turn limits", () => {
  it.each([
    { turns: 2, text: "", aborted: true },
    { turns: 1, text: "call:sample_tool{value:example}", aborted: false },
    { turns: 2, text: "call:sample_tool{value:example}", aborted: true },
  ])("preserves truncated output when the turn limit is reached: $turns/$text", async ({ turns, text, aborted }) => {
    session.prompt.mockImplementation(async () => {
      for (let turn = 0; turn < turns; turn++) {
        session.emit({ type: "turn_end", message: message(), toolResults: [] });
      }
      session.emit({ type: "message_end", message: message([{ type: "text", text }]) });
    });
    expect(await continueAgentSession(asSession(session), "Run", { maxTurns: 1, graceTurns: 0 }))
      .toEqual({ responseText: text, aborted, turnLimited: true });
  });

  it.each([
    { graceTurns: undefined, turns: 8, steers: 1, aborts: 1 },
    { graceTurns: 2, turns: 4, steers: 1, aborts: 1 },
    { graceTurns: 0, turns: 3, steers: 1, aborts: 1 },
    { graceTurns: 3, turns: 3, steers: 1, aborts: 0 },
  ])("enforces the soft limit and grace boundary: $graceTurns/$turns", async ({ graceTurns, turns, steers, aborts }) => {
    session.prompt.mockImplementation(async () => {
      for (let turn = 0; turn < turns; turn++) {
        session.emit({ type: "turn_end", message: message(), toolResults: [] });
      }
      session.emit({ type: "message_end", message: message() });
    });
    const result = await continueAgentSession(asSession(session), "Run", { maxTurns: 2, graceTurns });
    expect(session.steer).toHaveBeenCalledTimes(steers);
    expect(session.abort).toHaveBeenCalledTimes(aborts);
    expect(result.turnLimited).toBe(true);
  });

  it("reports the remaining turn budget in the steering message", async () => {
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "turn_end", message: message(), toolResults: [] });
      session.emit({ type: "message_end", message: message() });
    });
    await continueAgentSession(asSession(session), "Run", { maxTurns: 1, graceTurns: 0 });
    expect(session.steer.mock.calls[0][0]).toContain("1");
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("handles rejected steer and abort promises", async () => {
    session.steer.mockRejectedValue(new Error("closed steering channel"));
    session.abort.mockRejectedValue(new Error("closed abort channel"));
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "turn_end", message: message(), toolResults: [] });
      session.emit({ type: "turn_end", message: message(), toolResults: [] });
      session.emit({ type: "message_end", message: message() });
    });
    await expect(continueAgentSession(asSession(session), "Run", { maxTurns: 1, graceTurns: 0 })).resolves.toMatchObject({ turnLimited: true });
    await Promise.resolve();
  });
});

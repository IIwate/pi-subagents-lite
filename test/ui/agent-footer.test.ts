import { describe, expect, it, vi } from "vitest";
import { renderAgentFooterStats } from "../../src/ui/agent-footer.js";

function makeTheme(): any {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function makeRecord(): any {
  const model = {
    id: "gpt-5.6-sol",
    provider: "openai-codex",
    reasoning: true,
    contextWindow: 372_000,
  };
  return {
    display: {
      type: "general-purpose",
      description: "Implement feature",
      invocation: { modelName: "stale-model", providerName: "stale-provider", thinkingLevel: "low" },
    },
    execution: {
      session: {
        model,
        thinkingLevel: "xhigh",
        autoCompactionEnabled: true,
        modelRuntime: { isUsingOAuth: vi.fn(() => true) },
        getSessionStats: () => ({
          tokens: {
            input: 1_600_000,
            output: 120_000,
            cacheRead: 40_000_000,
            cacheWrite: 3_000,
            total: 41_723_000,
          },
          cost: 0.25,
        }),
        getContextUsage: () => ({ percent: 27.2, contextWindow: 372_000 }),
        sessionManager: {
          getEntries: () => [
            {
              type: "message",
              message: {
                role: "assistant",
                usage: {
                  input: 1_499_000,
                  output: 117_000,
                  cacheRead: 39_901_100,
                  cacheWrite: 2_400,
                  cost: { total: 0 },
                },
              },
            },
            {
              type: "message",
              message: {
                role: "assistant",
                usage: {
                  input: 1_000,
                  output: 1_000,
                  cacheRead: 98_900,
                  cacheWrite: 100,
                  cost: { total: 0 },
                },
              },
            },
          ],
        },
      },
    },
    stats: {
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 9, cost: 9 },
      contextPercent: 99,
    },
  };
}

describe("renderAgentFooterStats", () => {
  it("renders live child usage, context, model, and thinking level", () => {
    const record = makeRecord();
    const line = renderAgentFooterStats(record, makeTheme(), 160);

    expect(line).toContain("↑1.6M");
    expect(line).toContain("↓120k");
    expect(line).toContain("R40.0M");
    expect(line).toContain("W3k");
    expect(line).toContain("CH98.9%");
    expect(line).toContain("$0.250 (sub)");
    expect(line).toContain("27.2%/372k (auto)");
    expect(line).toContain("gpt-5.6-sol • openai-codex • xhigh");
    expect(line).not.toContain("stale-model");
    expect(record.execution.session.modelRuntime.isUsingOAuth)
      .toHaveBeenCalledWith("openai-codex");
  });

  it("omits thinking for a current model that does not support reasoning", () => {
    const record = makeRecord();
    record.execution.session.model = {
      id: "plain-model",
      provider: "test",
      reasoning: false,
      contextWindow: 32_000,
    };

    const line = renderAgentFooterStats(record, makeTheme(), 120);

    expect(line).toContain("plain-model");
    expect(line).not.toContain("xhigh");
  });

  it("falls back to captured invocation data before a session exists", () => {
    const record = makeRecord();
    record.execution.session = undefined;
    record.display.invocation = {
      modelName: "queued-model",
      providerName: "queued-provider",
      thinkingLevel: "high",
    };
    record.stats.lifetimeUsage = { input: 1_500, output: 250, cacheWrite: 0, cost: 0.125 };
    record.stats.contextPercent = null;

    const line = renderAgentFooterStats(record, makeTheme(), 100);

    expect(line).toContain("↑2k");
    expect(line).toContain("↓250");
    expect(line).toContain("$0.125");
    expect(line).toContain("queued-model • queued-provider • high");
  });
});

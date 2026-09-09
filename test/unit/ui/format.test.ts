import { summarizeToolArgs } from "../../../src/ui/format.js";
/**
 * format.test.ts — Tests for configurable stats filtering (buildStatsParts).
 *
 * buildStatsParts accepts a `visible` parameter controlling which stat
 * parts appear in the output. All flags default to true for backward
 * compatibility.
 */

import { describe, it, expect } from "vitest";
import { buildStatsParts, displayText, formatModelIdentity, formatMs } from "../../../src/ui/format.js";

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const allStats = {
  toolUses: 5,
  turnCount: 3,
  maxTurns: 30,
  input: 1000,
  output: 500,
  contextPercent: 50,
  compactions: 2,
  cost: 1.23,
  durationMs: 65000,
};

describe("buildStatsParts — visible flag: showTools", () => {
  it("excludes toolUses when showTools is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTools: false });
    expect(parts.some(p => p.includes("call"))).toBe(false);
  });

  it("includes toolUses when showTools is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("5 calls"))).toBe(true);
  });

  it("renders singular call when toolUses is 1", () => {
    const parts = buildStatsParts({ ...allStats, toolUses: 1 }, mockTheme);
    expect(parts.some(p => p === "1 call")).toBe(true);
  });
});

describe("buildStatsParts — provider / model(thinking) identity", () => {
  it("formats full provider/model(thinking) as a single part when no parent is set", () => {
    const parts = buildStatsParts({
      ...allStats,
      modelName: "grok-4.5",
      providerName: "cpa-responses",
      thinkingLevel: "high",
    }, mockTheme);
    expect(parts[0]).toBe("cpa-responses/grok-4.5(high)");
    expect(parts[1]).toBe("5 calls");
  });

  it("shows model only when thinking is missing", () => {
    const parts = buildStatsParts({
      ...allStats,
      modelName: "grok-4.5",
    }, mockTheme);
    expect(parts[0]).toBe("grok-4.5");
    expect(parts[1]).toBe("5 calls");
  });

  it("shows thinking only when model is missing", () => {
    const parts = buildStatsParts({
      ...allStats,
      thinkingLevel: "high",
    }, mockTheme);
    expect(parts[0]).toBe("(high)");
    expect(parts[1]).toBe("5 calls");
  });

  it("omits model/thinking when neither is set", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts[0]).toBe("5 calls");
  });

  it("omits model identity entirely when child matches parent completely", () => {
    const parts = buildStatsParts({
      ...allStats,
      providerName: "cpa",
      modelName: "gemini-3.8-flash-high",
      thinkingLevel: "high",
      parent: {
        providerName: "cpa",
        modelName: "gemini-3.8-flash-high",
        thinkingLevel: "high",
      },
    }, mockTheme);
    expect(parts[0]).toBe("5 calls");
  });

  it("shows full provider/model(thinking) when provider differs from parent", () => {
    const parts = buildStatsParts({
      ...allStats,
      providerName: "openai",
      modelName: "gpt-4o",
      thinkingLevel: "high",
      parent: {
        providerName: "cpa",
        modelName: "gpt-4o",
        thinkingLevel: "high",
      },
    }, mockTheme);
    expect(parts[0]).toBe("openai/gpt-4o(high)");
    expect(parts[1]).toBe("5 calls");
  });

  it("omits provider and shows model(thinking) when only model differs from parent", () => {
    const parts = buildStatsParts({
      ...allStats,
      providerName: "cpa",
      modelName: "gpt-4o",
      thinkingLevel: "high",
      parent: {
        providerName: "cpa",
        modelName: "gemini-3.8-flash-high",
        thinkingLevel: "high",
      },
    }, mockTheme);
    expect(parts[0]).toBe("gpt-4o(high)");
    expect(parts[1]).toBe("5 calls");
  });

  it("omits provider and shows model(thinking) when only thinking level differs from parent", () => {
    const parts = buildStatsParts({
      ...allStats,
      providerName: "cpa",
      modelName: "gemini-3.8-flash-high",
      thinkingLevel: "low",
      parent: {
        providerName: "cpa",
        modelName: "gemini-3.8-flash-high",
        thinkingLevel: "high",
      },
    }, mockTheme);
    expect(parts[0]).toBe("gemini-3.8-flash-high(low)");
    expect(parts[1]).toBe("5 calls");
  });

  it("formats tokens with space before ↓ and · before context %", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    const tokenPart = parts.find(p => p.includes("↑") && p.includes("↓"));
    expect(tokenPart).toBeDefined();
    expect(tokenPart).toContain("↑1k ↓500");
    expect(tokenPart).toContain(" · 50%");
    expect(tokenPart).toContain(" · ↻ 2");
  });
});

describe("formatModelIdentity — direct unit tests", () => {
  it("returns undefined when child has no identity fields", () => {
    expect(formatModelIdentity({})).toBeUndefined();
  });

  it("returns formatted provider only when model is missing", () => {
    expect(formatModelIdentity({ providerName: "custom-provider" })).toBe("custom-provider");
  });

  it("returns thinking only when model and provider are missing", () => {
    expect(formatModelIdentity({ thinkingLevel: "high" })).toBe("(high)");
  });

  it("returns undefined when matching empty parent properties", () => {
    expect(formatModelIdentity({ modelName: "gpt-4" }, { modelName: "gpt-4" })).toBeUndefined();
  });
});

describe("buildStatsParts — visible flag: showTurns", () => {
  it("excludes turns when showTurns is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTurns: false });
    expect(parts.some(p => p.includes("⟳"))).toBe(false);
  });

  it("includes turns when showTurns is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("⟳"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showInput/showOutput", () => {
  it("excludes token display when showInput and showOutput are both false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showInput: false, showOutput: false });
    expect(parts.some(p => p.includes("↑") || p.includes("↓"))).toBe(false);
  });

  it("excludes only input when showInput is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showInput: false });
    expect(parts.some(p => p.includes("↑"))).toBe(false);
    expect(parts.some(p => p.includes("↓"))).toBe(true);
  });

  it("excludes only output when showOutput is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showOutput: false });
    expect(parts.some(p => p.includes("↑"))).toBe(true);
    expect(parts.some(p => p.includes("↓"))).toBe(false);
  });
});

describe("buildStatsParts — visible flag: showContext", () => {
  it("excludes context percent and compactions when showContext is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showContext: false });
    expect(parts.some(p => p.includes("%"))).toBe(false);
    expect(parts.some(p => p.includes("↻"))).toBe(false);
  });

  it("includes context percent when showContext is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("%"))).toBe(true);
    expect(parts.some(p => p.includes("↻"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showCost", () => {
  it("excludes cost when showCost is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showCost: false });
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("includes cost when showCost is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showTime", () => {
  it("excludes time when showTime is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTime: false });
    // Match duration-like tokens, not the "s" inside "calls"
    expect(parts.some(p => /\d+m|\d+s|<1s/.test(p))).toBe(false);
  });

  it("includes time when durationMs is provided and showTime is true", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("1m"))).toBe(true);
  });

  it("includes time by default when durationMs is provided", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("1m"))).toBe(true);
  });
});

describe("buildStatsParts — all visible flags false", () => {
  it("returns empty array when all flags are false", () => {
    const parts = buildStatsParts(allStats, mockTheme, {
      showTools: false,
      showTurns: false,
      showInput: false,
      showOutput: false,
      showContext: false,
      showCost: false,
      showTime: false,
    });
    expect(parts).toEqual([]);
  });
});

describe("buildStatsParts — backward compatibility", () => {
  it("without visible parameter, behaves the same as before", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some(p => p.includes("calls"))).toBe(true);
    expect(parts.some(p => p.includes("⟳"))).toBe(true);
    expect(parts.some(p => p.includes("↑"))).toBe(true);
    expect(parts.some(p => p.includes("$"))).toBe(true);
  });
});

describe("buildStatsParts — cost behavior", () => {
  it("does not include cost when not provided", () => {
    const parts = buildStatsParts({
      toolUses: 5, turnCount: 3, maxTurns: 30, input: 1000, output: 500,
      contextPercent: 50, compactions: 2, durationMs: 65000,
    }, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("does not include cost when cost is 0", () => {
    const parts = buildStatsParts({ ...allStats, cost: 0 }, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("includes cost formatted as dollar amount", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => /^\$\d+\.\d{2}$/.test(p))).toBe(true);
  });
});

describe("formatMs", () => {
  it("formats hours, minutes, and seconds", () => {
    expect(formatMs(3661000)).toBe("1h 1m 1s");
  });

  it("formats minutes and seconds only", () => {
    expect(formatMs(337500)).toBe("5m 37s");
  });

  it("formats seconds only", () => {
    expect(formatMs(10000)).toBe("10s");
  });

  it("formats exactly zero seconds as <1s", () => {
    expect(formatMs(0)).toBe("<1s");
  });

  it("formats values under 1 second as <1s", () => {
    expect(formatMs(999)).toBe("<1s");
  });

  it("rounds down seconds (no decimals)", () => {
    expect(formatMs(1999)).toBe("1s");
  });

  it("handles exactly 1 hour", () => {
    expect(formatMs(3600000)).toBe("1h");
  });

  it("handles hours and seconds, zero minutes", () => {
    expect(formatMs(3601000)).toBe("1h 1s");
  });

  it("handles non-finite values as <1s", () => {
    expect(formatMs(Infinity)).toBe("<1s");
    expect(formatMs(NaN)).toBe("<1s");
  });

  it("handles negative values as <1s", () => {
    expect(formatMs(-1000)).toBe("<1s");
  });

  it("formats large durations", () => {
    expect(formatMs(90061000)).toBe("25h 1m 1s");
  });

  it("formatMs(1000) is exactly 1s, not <1s", () => {
    expect(formatMs(1000)).toBe("1s");
  });
});

describe("displayText", () => {
  it("removes BEL (\\x07) and ASCII control characters while preserving newlines", () => {
    expect(displayText("hello\x07world")).toBe("helloworld");
    expect(displayText("line 1\r\nline 2\x07")).toBe("line 1\nline 2");
    expect(displayText("\x1b[31mred\x1b[0m\x07")).toBe("red");
  });
});

describe("UI tool arguments summarizer edge cases (summarizeToolArgs)", () => {
  it("formats normal PowerShell command", () => {
    const summary = summarizeToolArgs("powershell", { command: "Get-Process -Name node" });
    expect(summary).toBe('("Get-Process -Name node")');
  });

  it("truncates long PowerShell command beyond MAX_COMMAND_DISPLAY_LENGTH (100 chars)", () => {
    const longCommand = "Write-Output " + "A".repeat(120);
    const summary = summarizeToolArgs("powershell", { command: longCommand });
    expect(summary.length).toBeLessThanOrEqual(106);
    expect(summary).toContain("…");
  });

  it("handles powershell call with empty, non-string or missing command argument safely", () => {
    expect(summarizeToolArgs("powershell", {})).toBe("");
    expect(summarizeToolArgs("powershell", undefined)).toBe("");
    expect(summarizeToolArgs("powershell", { command: null as any })).toBe('("")');
    expect(summarizeToolArgs("powershell", { command: 12345 as any })).toBe('("")');
  });
});

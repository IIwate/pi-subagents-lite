import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
// Review signals, not architectural proof: growth past a recorded size fails
// so the baseline cannot rot silently. Shrinking a file may ratchet the
// recorded value down; this list is not auto-lowered.
const sizeWarningBaseline: Readonly<Record<string, number>> = {
  "src/platform/pi/agent-session.ts": 756,
  "src/platform/pi/agent-types.ts": 166,
};

describe("size review signals", () => {
  it("fails when a listed file grows past its recorded size", () => {
    const warnings: string[] = [];
    for (const [file, baseline] of Object.entries(sizeWarningBaseline)) {
      const lineCount = readFileSync(resolve(projectRoot, file), "utf8").split(/\r?\n/).length - 1;
      if (lineCount > baseline) warnings.push(`${file}: ${baseline} -> ${lineCount}`);
    }
    expect(warnings).toEqual([]);
  });
});

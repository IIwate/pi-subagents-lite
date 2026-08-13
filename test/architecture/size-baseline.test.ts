import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
// Review signals, not architectural proof: growth past a recorded size asks
// for a split-or-justify review note, while shrinking files should ratchet
// the recorded value down.
const sizeWarningBaseline: Readonly<Record<string, number>> = {
  "src/platform/pi/agent-session.ts": 729,
  "src/agents/agent-types.ts": 410,
};

describe("size review signals", () => {
  it("reports growth beyond the recorded large-file sizes", () => {
    const warnings: string[] = [];
    for (const [file, baseline] of Object.entries(sizeWarningBaseline)) {
      const lineCount = readFileSync(resolve(projectRoot, file), "utf8").split(/\r?\n/).length - 1;
      if (lineCount > baseline) warnings.push(`${file}: ${baseline} -> ${lineCount}`);
    }
    if (warnings.length > 0) console.warn(`[architecture-size-warning]\n${warnings.join("\n")}`);
  });
});

import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
const sizeWarningBaseline: Readonly<Record<string, number>> = {
  "src/ui/agent-navigator.ts": 1497,
  "src/ui/menu/menu-model-routing.ts": 909,
  "src/platform/pi/agent-session.ts": 738,
  "src/config/config-store.ts": 457,
  "src/agents/agent-types.ts": 426,
};

describe("size review signals", () => {
  it("reports growth beyond the Phase 0 large-file baseline", () => {
    const warnings: string[] = [];
    for (const [file, baseline] of Object.entries(sizeWarningBaseline)) {
      const lineCount = readFileSync(resolve(projectRoot, file), "utf8").split(/\r?\n/).length - 1;
      if (lineCount > baseline) warnings.push(`${file}: ${baseline} -> ${lineCount}`);
    }
    if (warnings.length > 0) console.warn(`[architecture-size-warning]\n${warnings.join("\n")}`);
  });
});

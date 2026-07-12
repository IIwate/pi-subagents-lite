import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  isUnsafeName,
  isSymlink,
  safeReadFile,
  findModelInRegistry,
  parseModelKey,
  parseModelSpec,
  parseThinkingLevel,
  resolveExactModel,
  unknownModelError,
} from "../src/utils.ts";
import { tempDirFixture } from "./fixtures";

/* ------------------------------------------------------------------ */
/*  isUnsafeName                                                      */
/* ------------------------------------------------------------------ */

describe("isUnsafeName", () => {
  it("allows simple alphanumeric names", () => {
    expect(isUnsafeName("general-purpose")).toBe(false);
    expect(isUnsafeName("Explore")).toBe(false);
    expect(isUnsafeName("myAgent42")).toBe(false);
  });

  it("allows names with dots, hyphens, underscores", () => {
    expect(isUnsafeName("my.agent")).toBe(false);
    expect(isUnsafeName("code_review-v2")).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(isUnsafeName(".hidden")).toBe(true);
  });

  it("rejects path traversal (../)", () => {
    expect(isUnsafeName("../etc")).toBe(true);
  });

  it("rejects path traversal (..\\\\)", () => {
    expect(isUnsafeName("..\\etc")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isUnsafeName("")).toBe(true);
  });

  it("rejects names longer than 128 characters", () => {
    expect(isUnsafeName("a".repeat(129))).toBe(true);
  });

  it("allows exactly 128 characters", () => {
    expect(isUnsafeName("a".repeat(128))).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(isUnsafeName("my agent")).toBe(true);
  });

  it("rejects names with slashes", () => {
    expect(isUnsafeName("a/b")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  isSymlink                                                         */
/* ------------------------------------------------------------------ */

describe("isSymlink", () => {
  const { setup, getDir, teardown } = tempDirFixture("isSymlink-test");

  beforeEach(() => setup());
  afterEach(() => teardown());

  it("returns false for a regular file", () => {
    const file = join(getDir(), "regular.txt");
    writeFileSync(file, "hello", "utf-8");
    expect(isSymlink(file)).toBe(false);
  });

  it("returns true for a symlink", () => {
    const target = join(getDir(), "target.txt");
    writeFileSync(target, "target content", "utf-8");
    const link = join(getDir(), "link.txt");
    symlinkSync(target, link);
    expect(isSymlink(link)).toBe(true);
  });

  it("returns false for a non-existent file", () => {
    expect(isSymlink(join(getDir(), "nonexistent.txt"))).toBe(false);
  });

  it("returns false for a directory", () => {
    expect(isSymlink(getDir())).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  safeReadFile                                                      */
/* ------------------------------------------------------------------ */

describe("safeReadFile", () => {
  const { setup, getDir, teardown } = tempDirFixture("safeReadFile-test");

  beforeEach(() => setup());
  afterEach(() => teardown());

  it("reads a normal file", () => {
    const file = join(getDir(), "normal.txt");
    writeFileSync(file, "file content", "utf-8");
    expect(safeReadFile(file)).toBe("file content");
  });

  it("returns undefined for a symlink", () => {
    const target = join(getDir(), "target.txt");
    writeFileSync(target, "secret", "utf-8");
    const link = join(getDir(), "link.txt");
    symlinkSync(target, link);
    expect(safeReadFile(link)).toBeUndefined();
  });

  it("returns undefined for a missing file", () => {
    expect(safeReadFile(join(getDir(), "missing.txt"))).toBeUndefined();
  });

  it("returns undefined for a directory", () => {
    expect(safeReadFile(getDir())).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  parseModelKey / findModelInRegistry                               */
/* ------------------------------------------------------------------ */

describe("parseModelKey", () => {
  it("parses provider/model-id", () => {
    expect(parseModelKey("cpa-responses/grok-4.5")).toEqual({
      provider: "cpa-responses",
      modelId: "grok-4.5",
    });
  });

  it("returns null for bare model id", () => {
    expect(parseModelKey("grok-4.5")).toBeNull();
  });
});

describe("parseModelSpec", () => {
  it("parses bare model id", () => {
    expect(parseModelSpec("grok-4.5")).toEqual({ modelRef: "grok-4.5" });
  });

  it("parses provider/model-id", () => {
    expect(parseModelSpec("cpa-responses/grok-4.5")).toEqual({
      modelRef: "cpa-responses/grok-4.5",
    });
  });

  it("parses model:thinking shorthand", () => {
    expect(parseModelSpec("grok-4.5:low")).toEqual({
      modelRef: "grok-4.5",
      thinkingFromModel: "low",
    });
  });

  it("parses provider/model:thinking shorthand", () => {
    expect(parseModelSpec("cpa-responses/grok-4.5:high")).toEqual({
      modelRef: "cpa-responses/grok-4.5",
      thinkingFromModel: "high",
    });
  });

  it("accepts free-form thinking suffix not in the known list", () => {
    expect(parseModelSpec("grok-4.5:custom-level")).toEqual({
      modelRef: "grok-4.5",
      thinkingFromModel: "custom-level",
    });
  });

  it("does not split when thinking suffix is empty", () => {
    expect(parseModelSpec("grok-4.5:")).toEqual({ modelRef: "grok-4.5:" });
  });

  it("returns undefined modelRef for empty input", () => {
    expect(parseModelSpec(undefined)).toEqual({ modelRef: undefined });
    expect(parseModelSpec("  ")).toEqual({ modelRef: undefined });
  });
});

describe("parseThinkingLevel", () => {
  it("accepts known levels", () => {
    expect(parseThinkingLevel("low")).toBe("low");
    expect(parseThinkingLevel("xhigh")).toBe("xhigh");
  });

  it("accepts free-form levels", () => {
    expect(parseThinkingLevel("custom-level")).toBe("custom-level");
  });

  it("rejects empty / whitespace", () => {
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
    expect(parseThinkingLevel("   ")).toBeUndefined();
  });
});

describe("resolveExactModel", () => {
  const parent = { provider: "test", id: "parent-model" };
  const grok = { provider: "cpa-responses", id: "grok-4.5" };

  const registry = {
    find: (provider: string, modelId: string) => {
      if (provider === "cpa-responses" && modelId === "grok-4.5") return grok;
      if (provider === "test" && modelId === "parent-model") return parent;
      return undefined;
    },
    getAvailable: () => [grok, parent],
  };

  it("resolves provider/model-id via find", () => {
    expect(resolveExactModel("cpa-responses/grok-4.5", registry)).toBe(grok);
  });

  it("resolves bare model id with exact id match only", () => {
    expect(resolveExactModel("grok-4.5", registry)).toBe(grok);
  });

  it("returns undefined for unknown bare id (no silent fallback)", () => {
    expect(resolveExactModel("unknown-model", registry)).toBeUndefined();
  });

  it("returns undefined for unknown provider/id", () => {
    expect(resolveExactModel("cpa-responses/nope", registry)).toBeUndefined();
  });
});

describe("findModelInRegistry", () => {
  const parent = { provider: "test", id: "parent-model" };
  const grok = { provider: "cpa-responses", id: "grok-4.5" };

  const registry = {
    find: (provider: string, modelId: string) => {
      if (provider === "cpa-responses" && modelId === "grok-4.5") return grok;
      if (provider === "test" && modelId === "parent-model") return parent;
      return undefined;
    },
    getAvailable: () => [grok, parent],
  };

  it("returns fallback when modelStr is undefined", () => {
    expect(findModelInRegistry(undefined, registry, parent)).toBe(parent);
  });

  it("resolves provider/model-id via find", () => {
    expect(findModelInRegistry("cpa-responses/grok-4.5", registry, parent)).toBe(grok);
  });

  it("resolves bare model id via getAvailable", () => {
    expect(findModelInRegistry("grok-4.5", registry, parent)).toBe(grok);
  });

  it("falls back when bare id is unknown", () => {
    expect(findModelInRegistry("unknown-model", registry, parent)).toBe(parent);
  });
});

describe("unknownModelError", () => {
  it("mentions the unknown id and list-models guidance", () => {
    const msg = unknownModelError("nope");
    expect(msg).toContain("nope");
    expect(msg).toContain("list-models");
  });
});

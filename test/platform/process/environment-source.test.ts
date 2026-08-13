import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProcessEnvironmentSource,
  parseDotEnv,
} from "../../../src/platform/process/environment-source.js";
import { resolveOperationalValue } from "../../../src/modules/configuration/public.js";

const tempRoots: string[] = [];

function tempDotEnvFile(content?: string): string {
  const root = mkdtempSync(join(tmpdir(), "subagents-env-"));
  tempRoots.push(root);
  const filePath = join(root, ".env");
  if (content !== undefined) writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe(".env parsing contract", () => {
  it("reads KEY=VALUE pairs and strips one matching quote pair", () => {
    const values = parseDotEnv([
      "HOME=/dot-env-home",
      "QUOTED=\"with spaces\"",
      "SINGLE='single quoted'",
      "  PADDED  =  padded value  ",
    ].join("\n"));
    expect(values.get("HOME")).toBe("/dot-env-home");
    expect(values.get("QUOTED")).toBe("with spaces");
    expect(values.get("SINGLE")).toBe("single quoted");
    expect(values.get("PADDED")).toBe("padded value");
  });

  it("ignores comments, blank lines, and unparseable lines instead of guessing", () => {
    const values = parseDotEnv([
      "# comment",
      "",
      "not a pair",
      "1BAD=starts with digit",
      "GOOD=kept",
    ].join("\n"));
    expect([...values.keys()]).toEqual(["GOOD"]);
  });
});

describe("process environment source contract", () => {
  it("reads process variables and .env values as separate sources", () => {
    const source = createProcessEnvironmentSource({
      env: { HOME: "/env-home" },
      dotEnvFilePath: tempDotEnvFile("HOME=/dot-env-home\nONLY_DOT_ENV=here"),
    });
    expect(source.variable("HOME")).toBe("/env-home");
    expect(source.dotEnvValue("HOME")).toBe("/dot-env-home");
    expect(source.variable("ONLY_DOT_ENV")).toBeUndefined();
    expect(source.dotEnvValue("ONLY_DOT_ENV")).toBe("here");
  });

  it("treats a missing .env file as having no values", () => {
    const source = createProcessEnvironmentSource({
      env: {},
      dotEnvFilePath: join(tempDotEnvFile(), "never-created", ".env"),
    });
    expect(source.dotEnvValue("HOME")).toBeUndefined();
  });
});

describe("file, environment, and .env precedence", () => {
  it("resolves environment > .env > configured file > fallback through the real adapter", () => {
    const dotEnvFilePath = tempDotEnvFile("HOME=/dot-env-home");
    const withVariable = createProcessEnvironmentSource({ env: { HOME: "/env-home" }, dotEnvFilePath });
    const withoutVariable = createProcessEnvironmentSource({ env: {}, dotEnvFilePath });
    const withNeither = createProcessEnvironmentSource({
      env: {},
      dotEnvFilePath: join(tempDotEnvFile(), "never-created", ".env"),
    });

    const resolve = (source: typeof withVariable, configured?: string) => resolveOperationalValue({
      environment: source.variable("HOME"),
      dotEnv: source.dotEnvValue("HOME"),
      configured,
      fallback: "/fallback",
    });

    expect(resolve(withVariable, "/configured")).toBe("/env-home");
    expect(resolve(withoutVariable, "/configured")).toBe("/dot-env-home");
    expect(resolve(withNeither, "/configured")).toBe("/configured");
    expect(resolve(withNeither)).toBe("/fallback");
  });
});

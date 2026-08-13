import * as fs from "node:fs";
import type { EnvironmentSource } from "../../modules/configuration/public.js";

export interface CreateProcessEnvironmentSourceOptions {
  env: Readonly<Record<string, string | undefined>>;
  dotEnvFilePath: string;
}

/**
 * Parse the minimal `KEY=VALUE` dialect: blank lines and `#` comments are
 * skipped, keys must be identifier-shaped, and one pair of matching single or
 * double quotes is stripped from the value. There is no `export` prefix,
 * multi-line value, or interpolation support — an unparseable line is ignored
 * rather than guessed at, so a malformed `.env` degrades to lower-precedence
 * sources instead of injecting garbage.
 */
export function parseDotEnv(content: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.length >= 2 && (value.startsWith("\"") || value.startsWith("'")) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    values.set(match[1]!, value);
  }
  return values;
}

export function createProcessEnvironmentSource(
  options: CreateProcessEnvironmentSourceOptions,
): EnvironmentSource {
  // The .env file is read once, on first use: most processes never consult it
  // because the process environment wins, and a missing or unreadable file is
  // indistinguishable from an empty one by design.
  let dotEnv: ReadonlyMap<string, string> | undefined;
  const dotEnvValues = (): ReadonlyMap<string, string> => {
    if (!dotEnv) {
      let content = "";
      try {
        content = fs.readFileSync(options.dotEnvFilePath, "utf-8");
      } catch {
        content = "";
      }
      dotEnv = parseDotEnv(content);
    }
    return dotEnv;
  };
  return {
    variable: (name) => options.env[name],
    dotEnvValue: (name) => dotEnvValues().get(name),
  };
}

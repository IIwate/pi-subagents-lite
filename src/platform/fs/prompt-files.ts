import { readFileSync } from "node:fs";

export type CustomPromptReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "missing" | "empty" | "unreadable"; message: string };

export function readCustomPromptFile(filePath: string): CustomPromptReadResult {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) {
      return { ok: false, reason: "empty", message: `Custom prompt file is empty: ${filePath}` };
    }
    return { ok: true, content };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return { ok: false, reason: "missing", message: `Custom prompt file not found: ${filePath}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "unreadable", message: `Failed to read custom prompt file: ${message}` };
  }
}

export function readProjectContextFiles(options: {
  cwd: string;
  agentDir: string;
  load: (request: { cwd: string; agentDir: string }) => Array<{ path: string; content: string }>;
}): Array<{ path: string; content: string }> {
  try {
    return options.load({ cwd: options.cwd, agentDir: options.agentDir }).map((file) => ({
      path: file.path,
      content: file.content,
    }));
  } catch {
    return [];
  }
}

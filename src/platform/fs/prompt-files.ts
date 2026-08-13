import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

export function customPromptFileExists(filePath: string): boolean {
  return existsSync(filePath);
}

const CUSTOM_PROMPT_TEMPLATE = "You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously";

/** Create the starter custom prompt file; failure is reported, never thrown. */
export function createCustomPromptFile(filePath: string): { ok: true } | { ok: false; message: string } {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, CUSTOM_PROMPT_TEMPLATE, "utf-8");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
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

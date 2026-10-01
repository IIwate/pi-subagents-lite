/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * action-fusion.ts — fuse a file mutation and its follow-up command into one turn.
 *
 * Coding rollouts repeatedly show the same pair of turns: edit or write a
 * file, then run a command to test, build, or check it. This module decorates
 * the built-in `edit` and `write` tools with an optional `then_run` object,
 * applies the mutation, runs the command as a nested call of the same tool
 * call, and returns one combined observation. The model decision between the
 * two turns disappears.
 *
 * Subagent adaptations over the SoL-Pi original:
 * - The follow-up command routes through the host's nested execution
 *   (PiToolHost.executeNested), so the accepted-policy and active-set gates,
 *   nested-call records, and usage accounting apply exactly as they would to
 *   a model-issued shell call. An agent accepted without a shell tool gets
 *   THEN_RUN_REJECTED instead of a silent privilege escalation.
 * - The file queue is owned by ExtensionRuntime and shared across all child
 *   sessions: concurrent subagents mutating one workspace file serialize here.
 * - Shell selection is availability-driven (bash preferred, powershell
 *   fallback), matching whichever shell the accepted policy activated.
 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";
export const THEN_RUN_REJECTED = "[then_run:rejected]";

export interface ThenRunInput {
  command: string;
  /** Seconds; no default timeout when omitted. */
  timeout?: number;
}

/** Per-path serialization tails. Owned by ExtensionRuntime, shared by all child sessions. */
export type FusedFileQueue = Map<string, Promise<void>>;

/** Shell access for the fused follow-up command, bound to the child session's tool host. */
export interface ActionFusionShell {
  /** Permitted and currently active shell tool name, or undefined when the policy grants none. */
  available(): string | undefined;
  /** Execute the command as a nested call of the mutation tool call. */
  run(toolCallId: string, name: string, input: ThenRunInput, signal: AbortSignal | undefined): Promise<AgentToolCallOutcome>;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const WINDOWS_SHELL_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

function normalizeToolPath(filePath: string): string {
  const normalized = filePath.replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/**
 * Git Bash, MSYS, Cygwin, and WSL hand Pi paths like `/c/src/app.ts`. On
 * Windows, Pi's built-in mutation tools convert those to a native drive path
 * before touching the filesystem, so the queue and hash guard must convert
 * them the same way or they address a file the mutation never wrote.
 */
export function normalizeWindowsShellPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = WINDOWS_SHELL_DRIVE.exec(filePath);
  if (!match?.[1]) return filePath;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

export function resolveToolPath(cwd: string, filePath: string): string {
  const stripped = normalizeWindowsShellPath(normalizeToolPath(filePath));
  // Pi accepts file URLs; the queue and hash guard must use the same target.
  const expanded = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped;
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/") || (process.platform === "win32" && expanded.startsWith("~\\"))) {
    return resolve(homedir(), expanded.slice(2));
  }
  return resolve(cwd, expanded);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function canonicalQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  let current = resolvedPath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return resolvedPath;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Serialize fused operations for one canonical file path across every child
 * session. This queue intentionally does not nest Pi's built-in mutation
 * queue, and it does not gate plain (unfused) mutations — its sha256 guard,
 * not the lock alone, detects interference from those.
 */
export async function withFusedFileQueue<T>(tails: FusedFileQueue, filePath: string, work: () => Promise<T>): Promise<T> {
  const key = await canonicalQueueKey(filePath);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>(resolveOwned => { release = resolveOwned; });
  const tail = previous.then(() => owned);
  tails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

function thenRunSkippedError(error: unknown): Error {
  return new Error(`${errorText(error)}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function assertUnchangedBeforeCommand(
  path: string,
  yieldForInterference: () => Promise<void> = () => new Promise<void>(resolve => setImmediate(resolve)),
): Promise<void> {
  try {
    const mutationHash = await fileSha256(path);
    await yieldForInterference();
    const commandHash = await fileSha256(path);
    if (mutationHash !== commandHash) throw new Error("target content changed after the fused mutation");
  } catch (error) {
    throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`, { cause: error });
  }
}

async function executeMutationThenRun<TDetails>({ toolCallId, absolutePath, thenRun, mutate, shell, queue, signal }: {
  toolCallId: string;
  absolutePath: string;
  thenRun: ThenRunInput | undefined;
  mutate: () => Promise<AgentToolResult<TDetails>>;
  shell: ActionFusionShell;
  queue: FusedFileQueue;
  signal: AbortSignal | undefined;
}): Promise<AgentToolResult<TDetails>> {
  return withFusedFileQueue(queue, absolutePath, async () => {
    let mutationResult: AgentToolResult<TDetails>;
    try {
      mutationResult = await mutate();
    } catch (error) {
      if (thenRun !== undefined) throw thenRunSkippedError(error);
      throw error;
    }
    if (thenRun === undefined) return mutationResult;

    await assertUnchangedBeforeCommand(absolutePath);
    const shellName = shell.available();
    if (!shellName) {
      throw new Error([resultText(mutationResult),
        `${THEN_RUN_REJECTED} The accepted policy grants no active shell tool; the command was not run.`]
        .filter(Boolean).join("\n\n"));
    }
    const outcome = await shell.run(toolCallId, shellName, thenRun, signal);
    const output = resultText(outcome.result);
    if (outcome.isError) {
      throw new Error([resultText(mutationResult), THEN_RUN_FAILED, output].filter(Boolean).join("\n\n"));
    }
    return {
      ...mutationResult,
      content: [...mutationResult.content, { type: "text" as const, text: output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED }],
    };
  });
}

// Note: see .agents/notes/implemented/architecture/2026-10-01-action-fusion-then-run.md
/**
 * Decorate a built-in mutation tool (edit/write) with the optional `then_run`
 * parameter. The fused command runs in the tool's own task-resolved cwd,
 * routed through the child session's nested execution so the accepted tool
 * policy gates it exactly like a model-issued shell call.
 */
export function wrapMutationWithThenRun(tool: AgentTool<any>, options: {
  cwd: string;
  queue: FusedFileQueue;
  shell: ActionFusionShell;
}): AgentTool<any> {
  const description = `Command to run next on this file after the ${tool.name} succeeds — e.g. run, build, start/restart, `
    + `install, or check it; optional timeout in seconds. Skipped if the ${tool.name} fails; a non-zero exit is reported `
    + `but keeps the ${tool.name}.`;
  const base = tool.parameters as { properties?: Record<string, unknown> };
  return {
    ...tool,
    parameters: Type.Object({
      ...(base.properties ?? {}),
      then_run: Type.Optional(Type.Object({
        command: Type.String({ description: "Shell command to run (the session's active shell: bash or powershell)" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
      }, { description })),
    }),
    execute: (id: string, args: unknown, signal: AbortSignal | undefined, update: unknown) => {
      const { then_run, ...input } = args as { path: string; then_run?: ThenRunInput };
      return executeMutationThenRun({
        toolCallId: id,
        absolutePath: resolveToolPath(options.cwd, (args as { path: string }).path),
        thenRun: then_run,
        mutate: () => tool.execute(id, input, signal, update as never),
        shell: options.shell,
        queue: options.queue,
        signal,
      });
    },
  };
}

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted from SoL-Pi's observation-pack extension (observation.ts, index.ts,
 * https://github.com/NVlabs/SoL-Pi). The TUI reporting is dropped; the archive
 * lives in a sibling directory of the child session file and shares its
 * lifetime. Ledger writes are ordered after the projection decision so a
 * telemetry failure can never undo packing or cost the agent a recall page.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

/** Only tool results larger than this participate. */
export const THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
export const FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
export const PLACEHOLDER_EXCERPT_BYTES = 1024;
/** Built-in recall tool; every accepted child policy keeps it permitted and active. */
export const OBS_RECALL_TOOL_NAME = "obs_recall";
/** Recall responses never exceed these wire limits, header included. */
export const RECALL_MAX_BYTES = 16 * 1024;
export const RECALL_MAX_LINES = 400;

const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;
const RECALL_LIMITS = {
  maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
  maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

const CHARS_PER_TOKEN = 4;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Receipts from the evidence-preserving reducer are already a reduction of a
 * long log. Packing them again would replace verified evidence with an excerpt.
 */
const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

export interface Observation {
  readonly id: string;
  readonly contentHash: string;
  readonly filePath: string;
  readonly toolName: string;
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  readonly tokens: number;
}

export function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (const character of text) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function countBufferLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  return lines;
}

/** Only successful, purely textual results participate; details stay attached to the message. */
export function isPureTextResult(message: AgentMessage): message is ToolResultMessage {
  return (
    message.role === "toolResult" &&
    !message.isError &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "text")
  );
}

function textFromResult(message: ToolResultMessage): string {
  return (message.content as TextContent[]).map((block) => block.text).join("\n");
}

function containsReducerReceipt(text: string): boolean {
  return text.split("\n").some((line) => line === EVIDENCE_REDUCER_RECEIPT_PREFIX);
}

/**
 * Archived payloads live in a directory derived from the child session file.
 *
 * They are content addressed inside one session. A resume reuses the same
 * directory; the archive shares the session file's lifetime because durable
 * deliveries may reference placeholders long after the task settles.
 */
export function observationPath(archiveDir: string, id: string): string {
  return join(archiveDir, `${id}.txt`);
}

export function isObservationId(id: string): boolean {
  return OBSERVATION_ID_PATTERN.test(id);
}

export function createObservation(message: ToolResultMessage, archiveDir: string): Observation | undefined {
  const text = textFromResult(message);
  if (containsReducerReceipt(text)) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= THRESHOLD_BYTES) return undefined;

  const contentHash = hash(text);
  const id = `obs_${hash(`${message.toolName}\0${message.toolCallId}\0${contentHash}`).slice(0, 24)}`;
  return {
    id,
    contentHash,
    filePath: observationPath(archiveDir, id),
    toolName: message.toolName,
    text,
    bytes,
    lines: countLines(text),
    tokens: estimateTokens(text),
  };
}

/**
 * Write the payload to its content-addressed path, refusing symlinks and
 * verifying an existing object byte for byte before reusing it.
 */
export async function ensureStored(observation: Observation): Promise<void> {
  const directoryPath = dirname(observation.filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
    await handle.writeFile(observation.text, { encoding: "utf8" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
    try {
      const existing = await existingHandle.stat();
      if (!existing.isFile()) {
        throw new Error(`Content-addressed observation is not a regular file for ${observation.id}`, { cause: error });
      }
      if (existing.size !== observation.bytes) {
        throw new Error(`Content-addressed observation size mismatch for ${observation.id}`, { cause: error });
      }
      const existingContent = await existingHandle.readFile();
      if (hash(existingContent) !== observation.contentHash) {
        throw new Error(`Content-addressed observation hash mismatch for ${observation.id}`, { cause: error });
      }
    } finally {
      await existingHandle.close();
    }
  } finally {
    await handle?.close();
  }
}

function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  const lines = text.split(/(?<=\n)/);
  const selected: string[] = [];
  let selectedBytes = 0;
  let index = fromEnd ? lines.length - 1 : 0;

  while (index >= 0 && index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (selectedBytes + lineBytes > budgetBytes) break;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
    selectedBytes += lineBytes;
    index += fromEnd ? -1 : 1;
  }

  return selected.join("");
}

export function placeholderFor(observation: Observation): string {
  const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
  const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
  const head = completeLineExcerpt(observation.text, headBudget, false);
  const tail = completeLineExcerpt(observation.text, tailBudget, true);
  return [
    `[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
    `id: ${observation.id}`,
    `tool: ${observation.toolName}`,
    `original_bytes: ${observation.bytes}`,
    `original_lines: ${observation.lines}`,
    `estimated_tokens: ${observation.tokens}`,
    `retrieve: call ${OBS_RECALL_TOOL_NAME} with {"id":"${observation.id}","offset":0}; continue with returned next_offset`,
    `[first complete lines, up to ${headBudget} bytes]`,
    head,
    `[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
    tail,
    `[${observation.bytes} original bytes omitted]`,
  ].join("\n");
}

export interface RecallChunk {
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  readonly nextOffset: number;
  readonly eof: boolean;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
  let end = limit;
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}

export async function readRecallChunk(
  path: string,
  offset: number,
  limits: { readonly maxBytes: number; readonly maxLines: number },
): Promise<RecallChunk> {
  const handle = await open(path, READ_OBJECT_FLAGS);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
    if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);

    const available = Math.max(0, fileStats.size - offset);
    const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let end = Math.min(bytesRead, limits.maxBytes);
    let newlineCount = 0;

    for (let index = 0; index < end; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      newlineCount += 1;
      if (newlineCount === limits.maxLines) {
        end = index + 1;
        break;
      }
    }

    end = trimUtf8End(buffer, end);
    const chunk = buffer.subarray(0, end);
    const nextOffset = offset + chunk.length;
    return {
      text: chunk.toString("utf8"),
      bytes: chunk.length,
      lines: countBufferLines(chunk),
      nextOffset,
      eof: nextOffset >= fileStats.size,
    };
  } finally {
    await handle.close();
  }
}

export interface RecallResult {
  readonly content: TextContent[];
  readonly details: Record<string, unknown>;
}

// Note: see .agents/notes/implemented/architecture/2026-09-30-observation-packing-and-recall.md
/**
 * Per-child-session packing state: the content-addressed archive plus the
 * count of provider requests each observation has already been part of.
 */
export class ObservationSink {
  private readonly sentCounts = new Map<string, number>();

  constructor(readonly archiveDir: string) {}

  /**
   * Append-only operational journal in the archive directory (SoL-Pi parity:
   * full per send, placeholder per projection, recall per page). Telemetry must
   * never undo packing or cost the agent a recall page, so writes happen after
   * the projection decision and failures are reported and swallowed here.
   */
  private async logEvent(entry: Record<string, unknown>): Promise<void> {
    try {
      const ledgerPath = join(this.archiveDir, "ledger.jsonl");
      await mkdir(dirname(ledgerPath), { recursive: true });
      await appendFile(ledgerPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[subagents] observation ledger write failed: ${reason}`);
    }
  }

  /**
   * Replace large tool results that exhausted their full sends with stable
   * placeholders. This is a request-local projection: the stored session keeps
   * every original byte, so recall works after compaction and resume. Packing
   * fails open per message — a failure must never cost the agent its observation.
   */
  async project(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const projected = [...messages];
    // How many provider requests each message has already been part of,
    // counted by the assistant messages that follow it.
    const priorAssistantCounts = new Array<number>(messages.length);
    let assistantCount = 0;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      priorAssistantCounts[index] = assistantCount;
      if (messages[index]?.role === "assistant") assistantCount += 1;
    }

    const requestIndex = assistantCount + 1;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || !isPureTextResult(message)) continue;

      try {
        const observation = createObservation(message, this.archiveDir);
        if (!observation) continue;
        await ensureStored(observation);

        const previousSends = this.sentCounts.get(observation.id) ?? priorAssistantCounts[index] ?? 0;
        if (previousSends < FULL_SENDS) {
          this.sentCounts.set(observation.id, previousSends + 1);
          await this.logEvent({
            event: "full", id: observation.id, request: requestIndex, tool: observation.toolName,
            originalBytes: observation.bytes, originalLines: observation.lines,
            originalTokens: observation.tokens, contentHash: observation.contentHash,
          });
          continue;
        }

        const placeholder = placeholderFor(observation);
        projected[index] = { ...message, content: [{ type: "text", text: placeholder }] };
        this.sentCounts.set(observation.id, previousSends + 1);
        const placeholderTokens = estimateTokens(placeholder);
        await this.logEvent({
          event: "placeholder", id: observation.id, request: requestIndex, sendNumber: previousSends + 1,
          tool: observation.toolName, originalBytes: observation.bytes, originalLines: observation.lines,
          originalTokens: observation.tokens, placeholderBytes: Buffer.byteLength(placeholder, "utf8"),
          placeholderTokens, removedTokens: Math.max(0, observation.tokens - placeholderTokens),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[subagents] observation packing fail-open for tool result: ${reason}`);
      }
    }

    return projected;
  }

  /** Read one bounded page of a stored observation; unknown ids and offsets fail visibly. */
  async recall(id: string, offset = 0): Promise<RecallResult> {
    if (!isObservationId(id)) throw new Error(`Unknown observation id: ${id}`);
    let chunk: RecallChunk;
    try {
      chunk = await readRecallChunk(observationPath(this.archiveDir, id), offset, RECALL_LIMITS);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Unknown observation id: ${id}`, { cause: error });
      }
      throw error;
    }
    const header = [
      `[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
      `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
    ].join("\n");
    const content = `${header}\n${chunk.text}`;
    if (Buffer.byteLength(content, "utf8") > RECALL_MAX_BYTES || countLines(content) > RECALL_MAX_LINES) {
      throw new Error("Recall output exceeded its hard limit");
    }
    await this.logEvent({
      event: "recall", id, offset, bytes: chunk.bytes, lines: chunk.lines,
      nextOffset: chunk.nextOffset, eof: chunk.eof,
    });
    return {
      content: [{ type: "text", text: content }],
      details: {
        id,
        offset,
        bytes: chunk.bytes,
        lines: chunk.lines,
        nextOffset: chunk.nextOffset,
        eof: chunk.eof,
      },
    };
  }
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createObservation, ensureStored, FULL_SENDS, isPureTextResult, OBS_RECALL_TOOL_NAME, ObservationSink, observationPath,
  readRecallChunk, THRESHOLD_BYTES,
} from "../../../src/drivers/observation-sink.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

function largeText(lines = 600): string {
  return Array.from({ length: lines }, (_, index) => `line ${String(index).padStart(4, "0")} ${"y".repeat(24)}`).join("\n") + "\n";
}

function resultMessage(text: string, toolName = "read"): ToolResultMessage {
  return { role: "toolResult", toolCallId: "call-1", toolName, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

const assistant = () => ({ role: "assistant" }) as unknown as AgentMessage;
const user = () => ({ role: "user", content: "Inspect the output", timestamp: Date.now() }) as AgentMessage;

describe("Observation sink", () => {
  let resources: TestHarness;
  let directory: string;
  beforeEach(() => { resources = createTestHarness(); directory = resources.createTempDir("pi-observation-sink-"); });
  afterEach(() => resources.dispose());

  it("packs only large pure-text results and exempts evidence receipts", () => {
    expect(createObservation(resultMessage("small"), directory)).toBeUndefined();
    // Evidence-preserving reducer receipts are verified evidence; packing would replace them with an excerpt.
    const receipt = ["sol_pi_evidence_receipt_v1", largeText()].join("\n");
    expect(createObservation(resultMessage(receipt), directory)).toBeUndefined();
    // Recall pages are ordinary large results: they participate in packing (SoL-Pi parity).
    expect(createObservation(resultMessage(largeText(), OBS_RECALL_TOOL_NAME), directory)).toBeDefined();
    const observation = createObservation(resultMessage(largeText()), directory)!;
    expect(observation.id).toMatch(/^obs_[a-f0-9]{24}$/u);
    expect(observation.filePath).toBe(observationPath(directory, observation.id));
    expect(observation.bytes).toBeGreaterThan(THRESHOLD_BYTES);
    expect(isPureTextResult(resultMessage("text"))).toBe(true);
    expect(isPureTextResult({ ...resultMessage("text"), isError: true })).toBe(false);
    expect(isPureTextResult({ ...resultMessage(""), content: [] })).toBe(false);
    expect(isPureTextResult({ ...resultMessage(""), content: [{ type: "image", data: "AA", mimeType: "image/png" }] } as unknown as AgentMessage)).toBe(false);
    expect(isPureTextResult(assistant())).toBe(false);
  });

  it("stores content-addressed objects and verifies an existing object byte for byte", async () => {
    const observation = createObservation(resultMessage(largeText()), directory)!;
    await ensureStored(observation);
    await ensureStored(observation);
    expect(readFileSync(observation.filePath, "utf8")).toBe(observation.text);
    writeFileSync(observation.filePath, `X${observation.text.slice(1)}`);
    await expect(ensureStored(observation)).rejects.toThrow("hash mismatch");
  });

  it("pages recall chunks on byte, line, and UTF-8 boundaries", async () => {
    const text = `${"prefix\n"}${"汉字边界\n".repeat(200)}${"suffix\n"}`;
    const path = join(directory, "paged.txt");
    writeFileSync(path, text);
    const first = await readRecallChunk(path, 0, { maxBytes: 100, maxLines: 400 });
    expect(first.bytes).toBeLessThanOrEqual(100);
    expect(first.text).not.toContain("�");
    expect(first.eof).toBe(false);
    let offset = first.nextOffset;
    let restored = first.text;
    while (offset < Buffer.byteLength(text, "utf8")) {
      const chunk = await readRecallChunk(path, offset, { maxBytes: 100, maxLines: 400 });
      restored += chunk.text;
      offset = chunk.nextOffset;
      if (chunk.eof) break;
    }
    expect(restored).toBe(text);
    const lined = await readRecallChunk(path, 0, { maxBytes: 1_000_000, maxLines: 3 });
    expect(lined.lines).toBe(3);
    expect(lined.text).toBe("prefix\n汉字边界\n汉字边界\n");
    await expect(readRecallChunk(path, Buffer.byteLength(text, "utf8") + 1, { maxBytes: 10, maxLines: 10 })).rejects.toThrow("exceeds");
  });

  it("sends full payloads twice, then projects a stable placeholder and pages it back", async () => {
    const sink = new ObservationSink(directory);
    const result = resultMessage(largeText());
    // A fresh large result sits at the tail; each provider request appends one assistant message.
    let messages: AgentMessage[] = [user(), result];

    for (let send = 0; send < FULL_SENDS; send += 1) {
      const projected = await sink.project(messages);
      expect((projected[1] as ToolResultMessage).content).toEqual(result.content);
      messages = [...messages, assistant()];
    }

    const packed = await sink.project(messages);
    const placeholder = (packed[1] as ToolResultMessage).content[0];
    expect(placeholder.type).toBe("text");
    const text = (placeholder as { text: string }).text;
    expect(text).toContain("[large tool result replaced");
    expect(text).toContain("original_bytes:");
    expect(text).toContain("line 0000");
    expect(text).not.toContain("line 0300");
    const id = text.match(/"id":"(obs_[a-f0-9]{24})"/)![1];

    const repacked = await sink.project(messages);
    expect((repacked[1] as ToolResultMessage).content).toEqual((packed[1] as ToolResultMessage).content);

    const page = await sink.recall(id, 0);
    expect(page.details).toMatchObject({ id, offset: 0, eof: false });
    expect(page.content[0].text).toContain(`[obs_recall id=${id} offset=0 next_offset=`);
    expect(page.content[0].text).toContain("line 0000");
    let offset = page.details.nextOffset as number;
    let restored = page.content[0].text.split("\n").slice(2).join("\n");
    while (true) {
      const chunk = await sink.recall(id, offset);
      restored += chunk.content[0].text.split("\n").slice(2).join("\n");
      offset = chunk.details.nextOffset as number;
      if (chunk.details.eof) break;
    }
    expect(restored).toBe((result.content[0] as { text: string }).text);
    await expect(sink.recall("not-an-id")).rejects.toThrow("Unknown observation id");
    await expect(sink.recall("obs_000000000000000000000000")).rejects.toThrow("Unknown observation id");
  });

  it("journals full, placeholder, and recall events, and a broken ledger never blocks packing", async () => {
    const sink = new ObservationSink(directory);
    const result = resultMessage(largeText());
    let messages: AgentMessage[] = [user(), result];

    for (let send = 0; send < FULL_SENDS; send += 1) {
      await sink.project(messages);
      messages = [...messages, assistant()];
    }
    await sink.project(messages); // first placeholder projection

    const events = () => readFileSync(join(directory, "ledger.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { event: string; id?: string; offset?: number; eof?: boolean });
    expect(events().map(entry => entry.event)).toEqual(["full", "full", "placeholder"]);

    const id = createObservation(result, directory)!.id;
    await sink.recall(id, 0);
    expect(events().map(entry => entry.event)).toEqual(["full", "full", "placeholder", "recall"]);
    expect(events().at(-1)).toMatchObject({ event: "recall", id, offset: 0, eof: false });

    // A ledger path that cannot be appended (a directory) must not undo packing or lose a recall page.
    const blocked = resources.createTempDir("pi-observation-ledger-blocked-");
    mkdirSync(join(blocked, "archive", "ledger.jsonl"), { recursive: true });
    const resilient = new ObservationSink(join(blocked, "archive"));
    const packed = await resilient.project([user(), result, ...Array.from({ length: FULL_SENDS }, assistant)]);
    expect(((packed[1] as ToolResultMessage).content[0] as { text: string }).text).toContain("[large tool result replaced");
    const page = await resilient.recall(id, 0);
    expect(page.content[0].text).toContain(`[obs_recall id=${id} offset=0`);
  });

  it("uses the following assistant count after a resume and fails open when storage is unavailable", async () => {
    const result = resultMessage(largeText());
    const messages: AgentMessage[] = [user(), result, ...Array.from({ length: FULL_SENDS }, assistant)];
    const resumed = await new ObservationSink(directory).project(messages);
    expect(((resumed[1] as ToolResultMessage).content[0] as { text: string }).text).toContain("[large tool result replaced");

    const file = join(directory, "not-a-directory");
    writeFileSync(file, "plain file");
    const failing = new ObservationSink(join(file, "archive"));
    const projected = await failing.project([user(), result, assistant()]);
    expect((projected[1] as ToolResultMessage).content).toEqual(result.content);
  });
});

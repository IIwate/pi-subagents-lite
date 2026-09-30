import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type Context as ProviderContext } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { createRuntimeHost, resultEntries, settled, spawn } from "../../support/runtime.js";

const MARKER_MIDDLE = "payload line 0300";
const MARKER_TAIL = "payload line 0599";

describe("Observation packing in a child session", () => {
  let harness: TestHarness;
  beforeEach(() => { harness = createTestHarness(); });
  afterEach(() => harness.dispose());

  it("replaces a large result after two full sends, pages it back with a whitelisted read-only agent, packs the page itself, and keeps deliveries clean", async () => {
    const parent = await createRuntimeHost(harness, "obs-pack");
    const bigText = Array.from({ length: 600 }, (_, index) => `payload line ${String(index).padStart(4, "0")} ${"x".repeat(24)}`).join("\n") + "\n";
    writeFileSync(join(parent.directory, "big.txt"), bigText);
    writeFileSync(join(parent.directory, "small.txt"), "small note");

    const requests: ProviderContext[] = [];
    const respond = (request: ProviderContext) => {
      requests.push(request);
      if (request.messages.some(message => message.role === "toolResult" && message.toolName === "obs_recall")) {
        return fauxAssistantMessage("Recall finished");
      }
      const resultTexts = request.messages.flatMap(message => message.role === "toolResult"
        ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []);
      const id = resultTexts.find(text => text.includes("[large tool result replaced"))?.match(/"id":"(obs_[a-f0-9]{24})"/)?.[1];
      if (id) return fauxAssistantMessage(fauxToolCall("obs_recall", { id, offset: 0 }), { stopReason: "toolUse" });
      if (request.messages.some(message => message.role === "toolResult")) {
        return fauxAssistantMessage(fauxToolCall("read", { path: "small.txt" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: "big.txt" }), { stopReason: "toolUse" });
    };
    parent.worker.setResponses(Array.from({ length: 6 }, () => respond));

    const task = await spawn(parent, "Inspect big.txt");
    await settled(harness, parent.runtime, task.taskId);
    expect(parent.runtime.engine.get(task.taskId).state).toMatchObject({ status: "settled",
      outcome: { status: "completed", result: "Recall finished" } });

    expect(requests).toHaveLength(5);
    // The first two requests after the large result still carry it in full.
    expect(JSON.stringify(requests[1].messages)).toContain(MARKER_TAIL);
    expect(JSON.stringify(requests[2].messages)).toContain(MARKER_TAIL);
    // The third request projects a placeholder: head excerpt kept, middle omitted.
    const packed = JSON.stringify(requests[3].messages);
    expect(packed).toContain("[large tool result replaced");
    expect(packed).toContain("original_bytes:");
    expect(packed).toContain("payload line 0000");
    expect(packed).not.toContain(MARKER_MIDDLE);
    // The whitelist read-only policy keeps the built-in recall tool declared and callable.
    const declared = (getCurrentTools(requests[3].messages) ?? []).map(tool => tool.name);
    expect(declared).toEqual(expect.arrayContaining(["read", "obs_recall"]));
    expect(declared).not.toContain("write");
    // The recall page is bounded and continues through next_offset.
    const recalled = JSON.stringify(requests[4].messages);
    expect(recalled).toMatch(/\[obs_recall id=obs_[a-f0-9]{24} offset=0 next_offset=[1-9][0-9]* eof=false\]/u);
    expect(recalled).toContain("payload line 0000");

    // The parent delivery carries the final text with no observation plumbing leaked.
    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
    expect(resultEntries(parent)).toHaveLength(1);
    const parentLog = readFileSync(parent.session.sessionManager.getSessionFile()!, "utf8");
    expect(parentLog).toContain("Recall finished");
    expect(parentLog).not.toContain("obs_");
    expect(parent.errors).toEqual([]);

    // SoL-Pi parity: the recall page is an ordinary large result and packs after
    // two more provider requests. Two continuations supply exactly those sends.
    parent.worker.setResponses([
      request => { requests.push(request); return fauxAssistantMessage("Follow-up analysis one"); },
      request => { requests.push(request); return fauxAssistantMessage("Follow-up analysis two"); },
    ]);
    await parent.runtime.engine.continue(task.taskId, { text: "Analyze further" });
    await parent.runtime.engine.wait(task.taskId);
    await parent.runtime.engine.continue(task.taskId, { text: "Analyze once more" });
    await parent.runtime.engine.wait(task.taskId);

    expect(requests).toHaveLength(7);
    const finalTexts = requests.at(-1)!.messages.flatMap(message => message.role === "toolResult"
      ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []);
    const placeholderIds = new Set(finalTexts.filter(text => text.startsWith("[large tool result replaced"))
      .map(text => text.match(/"id":"(obs_[a-f0-9]{24})"/)![1]));
    expect(placeholderIds.size).toBe(2);

    // The archive lives beside the session file and holds the exact observed bytes
    // for the big result, plus the recall page as its own observation object.
    const readResult = requests[1].messages.find((message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolName === "read")!;
    const observedText = readResult.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    const archived = globSync(join(parent.directory, "subagents-lite-v3", "sessions", "**", "*.observations", "obs_*.txt"));
    expect(archived).toHaveLength(2);
    const archivedTexts = archived.map(path => readFileSync(path, "utf8"));
    expect(archivedTexts).toContain(observedText);
    expect(archivedTexts.some(text => text.startsWith("[obs_recall id=obs_"))).toBe(true);

    await parent.runtime.flushDeliveries(); await parent.session.waitForIdle();
  });
});

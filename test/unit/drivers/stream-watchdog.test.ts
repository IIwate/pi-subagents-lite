import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { withStreamWatchdog } from "../../../src/drivers/stream-watchdog.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";
import { controlledModelStream } from "../../support/model-stream.js";

const model = fauxProvider({ models: [{ id: "reasoner", reasoning: true }] }).models[0];

describe("Model stream watchdog", () => {
  let resources: TestHarness;
  beforeEach(() => { resources = createTestHarness(); vi.useFakeTimers(); });
  afterEach(() => resources.dispose());

  function request(parent = new AbortController()) {
    const controlled = controlledModelStream(resources, model);
    let signal!: AbortSignal;
    const open = vi.fn((requestSignal: AbortSignal) => { signal = requestSignal; return controlled.source; });
    const output = withStreamWatchdog(model, parent.signal, open);
    const events: AssistantMessageEvent[] = [];
    const consumed = (async () => { for await (const event of output) events.push(event); })();
    resources.onDispose(async () => { parent.abort(); await consumed; });
    return { ...controlled, signal, parent, output, open, events, consumed };
  }

  it("expires the first-content budget despite empty start and delta events", async () => {
    const stream = request();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(stream.signal.aborted).toBe(false);
    stream.text("");
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.signal.aborted).toBe(true);
    expect(stream.parent.signal.aborted).toBe(false);
    expect(await stream.output.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("600 seconds") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes the thinking budget and keeps the shorter window after output starts", async () => {
    const stream = request();
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(590_000);
      expect(stream.signal.aborted).toBe(false);
      stream.thinking("Still reasoning");
      await vi.advanceTimersByTimeAsync(0);
    }
    stream.text("Answer");
    await vi.advanceTimersByTimeAsync(110_000);
    stream.thinking("Checking");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(stream.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stream.output.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("120 seconds") });
  });

  it.each(["text", "toolcall"] as const)("bounds a stalled %s stream and freezes its partial result before abort", async kind => {
    const stream = request();
    const partial = stream.partial;
    if (kind === "text") stream.text("Partial result");
    else {
      partial.content.push({ type: "toolCall", id: "call", name: "probe", arguments: {} });
      stream.source.push({ type: "toolcall_start", contentIndex: 0, partial });
    }
    const content = structuredClone(partial.content);
    stream.signal.addEventListener("abort", () => {
      partial.content = [{ type: "text", text: "Late provider mutation" }];
      stream.source.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
    }, { once: true });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(stream.signal.aborted).toBe(false);
    stream.source.push({ type: kind === "text" ? "text_delta" : "toolcall_delta", contentIndex: 0, delta: "", partial });
    await vi.advanceTimersByTimeAsync(1);
    const result = await stream.output.result();
    expect(result).toMatchObject({ stopReason: "error", content });
    expect(stream.signal.reason).toBeInstanceOf(Error);
    await stream.consumed;
    expect(stream.events.filter(event => event.type === "error")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles cancellation even when a provider never emits an abort event", async () => {
    const stream = request();
    stream.parent.abort(new Error("User stopped the task"));
    expect(await stream.output.result()).toMatchObject({ stopReason: "aborted", errorMessage: "User stopped the task" });
    expect(stream.signal.aborted).toBe(true);
    await stream.consumed;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stream.events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not open an already cancelled request", async () => {
    const parent = new AbortController();
    parent.abort(new Error("Session closed"));
    const stream = request(parent);
    expect(stream.open).not.toHaveBeenCalled();
    expect(await stream.output.result()).toMatchObject({ stopReason: "aborted", errorMessage: "Session closed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["done", "error"] as const)("cleans up after a provider %s without aborting a completed request", async kind => {
    const stream = request();
    const message = fauxAssistantMessage("Final result", kind === "error" ? { stopReason: "error", errorMessage: "Authentication failed" } : {});
    stream.source.push(kind === "done" ? { type: "done", reason: "stop", message } : { type: "error", reason: "error", error: message });
    expect(await stream.output.result()).toBe(message);
    stream.parent.abort();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stream.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports premature stream closure and releases synchronous setup failures", async () => {
    const stream = request();
    stream.source.end();
    expect(await stream.output.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("ended without a terminal response event") });
    expect(stream.signal.aborted).toBe(true);
    const failure = new Error("Missing credentials");
    expect(() => withStreamWatchdog(model, undefined, () => { throw failure; })).toThrow(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});

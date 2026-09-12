import { createAssistantMessageEventStream, fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import type { TestHarness } from "./harness.js";

/** A provider stream whose progress and completion are controlled by the test. */
export function controlledModelStream(resources: TestHarness, model: Model<Api>) {
  const source = createAssistantMessageEventStream();
  const partial = { ...fauxAssistantMessage([], { stopReason: "pending" }), api: model.api, provider: model.provider, model: model.id };
  let block: { type: "text"; text: string } | { type: "thinking"; thinking: string } | undefined;
  const endBlock = () => {
    if (!block) return;
    const contentIndex = partial.content.length - 1;
    if (block.type === "text") source.push({ type: "text_end", contentIndex, content: block.text, partial });
    else source.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
    block = undefined;
  };
  const append = (kind: "text" | "thinking", delta: string) => {
    if (block?.type !== kind) {
      endBlock();
      block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
      partial.content.push(block);
      source.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: partial.content.length - 1, partial });
    }
    if (block.type === "text") block.text += delta;
    else block.thinking += delta;
    source.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: partial.content.length - 1, delta, partial });
  };
  source.push({ type: "start", partial });
  resources.onDispose(() => { source.end({ ...partial, stopReason: "aborted" }); });
  return {
    source, partial,
    text: (delta: string) => append("text", delta),
    thinking: (delta: string) => append("thinking", delta),
    finish(text?: string) {
      if (text) append("text", text);
      endBlock();
      partial.stopReason = "stop";
      source.push({ type: "done", reason: "stop", message: partial });
      source.end(partial);
    },
  };
}

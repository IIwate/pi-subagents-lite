import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model,
} from "@earendil-works/pi-ai";

const THINKING_IDLE_MS = 600_000;
const OUTPUT_IDLE_MS = 120_000;

function progress(event: AssistantMessageEvent): "thinking" | "output" | undefined {
  switch (event.type) {
    case "text_delta":
    case "toolcall_delta": return event.delta.length ? "output" : undefined;
    case "text_end": return event.content.length ? "output" : undefined;
    case "toolcall_start":
    case "toolcall_end": return "output";
    case "thinking_delta": return event.delta.length ? "thinking" : undefined;
    case "thinking_end": return "thinking";
    case "thinking_start": {
      const block = event.partial.content[event.contentIndex];
      return block?.type === "thinking" && block.redacted ? "thinking" : undefined;
    }
    default: return undefined;
  }
}

// Note: see .agents/notes/implemented/bug-fix/2026-09-10-assistant-outcomes-retries-and-turn-budgets.md
export function withStreamWatchdog(
  model: Model<Api>,
  signal: AbortSignal | undefined,
  open: (signal: AbortSignal) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const controller = new AbortController();
  let source: AssistantMessageEventStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outputStarted = false;
  let terminal: AssistantMessage | undefined;
  let partial: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
    stopReason: "pending", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };

  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  };
  const finish = (event: Extract<AssistantMessageEvent, { type: "done" | "error" }>) => {
    if (terminal) return;
    terminal = event.type === "done" ? event.message : event.error;
    cleanup();
    output.push(event);
    output.end(terminal);
  };
  const abort = (reason: "error" | "aborted", error: unknown) => {
    if (terminal) return;
    // Providers mutate their partial response even while handling cancellation.
    const message: AssistantMessage = { ...structuredClone(partial), stopReason: reason,
      errorMessage: error instanceof Error ? error.message : String(error) };
    finish({ type: "error", reason, error: message });
    controller.abort(error);
    // This request owns its source reader. Release it even if the provider omits a terminal event.
    source?.end(message);
  };
  const cancel = () => { abort("aborted", signal?.reason ?? new Error("Model request aborted")); };
  const refresh = () => {
    clearTimeout(timer);
    const budget = outputStarted ? OUTPUT_IDLE_MS : THINKING_IDLE_MS;
    timer = setTimeout(() => {
      // Only the request signal is aborted; native durable control must remain eligible for retry.
      abort("error", new Error(`Model stream timed out after ${budget / 1000} seconds without ${outputStarted ? "output" : "thinking or output"} progress`));
    }, budget);
  };

  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
    return output;
  }
  refresh();
  try {
    source = open(controller.signal);
  } catch (error) {
    cleanup();
    controller.abort(error);
    throw error;
  }
  if (terminal) {
    source.end(terminal);
    return output;
  }

  const input = source;
  void (async () => {
    try {
      for await (const event of input) {
        if (terminal) return;
        if (event.type === "done" || event.type === "error") {
          finish(event);
          return;
        }
        partial = event.partial;
        const activity = progress(event);
        if (activity) {
          outputStarted ||= activity === "output";
          refresh();
        }
        output.push(event);
      }
      abort("error", new Error("Model stream ended without a terminal response event"));
    } catch (error) {
      abort(signal?.aborted ? "aborted" : "error", error);
    }
  })();
  return output;
}

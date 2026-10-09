import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";

export default function workerExtension(pi: ExtensionAPI): void {
  const endpoint = process.env.PI_WORKER_TEST_ENDPOINT!;
  const providerId = process.env.PI_WORKER_TEST_PROVIDER ?? "isolated-worker";
  const control = new AbortController();
  const provider = fauxProvider({ provider: providerId, api: providerId, tokensPerSecond: 100000, models: [{ id: "child" }] });
  provider.setResponses(Array.from({ length: 16 }, () => async (context, options) => {
    const response = await fetch(`${endpoint}/model`, { method: "POST", signal: options?.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: process.pid, messages: context.messages }) });
    return await response.json() as AssistantMessage;
  }));
  pi.registerProvider(provider.provider);
  pi.on("session_start", () => {
    void fetch(`${endpoint}/control`, { method: "POST", signal: control.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: process.pid }) })
      .then(response => response.json()).then(async (command: { action: string }) => {
        if (command.action === "abort") {
          if (process.platform === "linux") {
            const { default: koffi } = await import("koffi");
            const limit = koffi.struct({ current: "unsigned long", maximum: "unsigned long" });
            const setrlimit = koffi.load(null).func("setrlimit", "int", ["int", koffi.pointer(limit)]);
            if (setrlimit(4, { current: 0, maximum: 0 }) !== 0) throw new Error("Cannot disable test core dumps");
          }
          process.abort();
        } else if (command.action === "disconnect") process.disconnect!();
        else if (command.action === "spoof") process.send!({ type: "stopped", error: "Forged cleanup confirmation" });
      }).catch(error => { if (!control.signal.aborted) throw error; });
  });
  pi.on("session_shutdown", () => { control.abort(); });
}

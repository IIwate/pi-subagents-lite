import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "./runtime.js";
import { registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";

export default function (pi: ExtensionAPI): void {
  const runtime = new ExtensionRuntime(pi);
  registerTools(pi, runtime);
  setupEventListeners(pi, runtime);
}

import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentSnapshot,
  InteractionResult,
} from "../modules/subagent-runtime/public.js";
import type { SpawnConfig } from "../types.js";
import type { PendingResult } from "./result-inbox.js";

export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  signal?: AbortSignal;
  runInBackground: boolean;
}

export interface SpawnResult {
  agentId: string;
  snapshot: AgentSnapshot;
}

export interface SpawnCoordinatorApi {
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult>;
  interact(agentId: string, message: string, images?: ImageContent[]): Promise<InteractionResult>;
  onAgentComplete(record: AgentSnapshot): void;
  prepareBeforeAgentStart(): {
    customType: string;
    content: string;
    display: false;
  } | undefined;
  onParentAgentStart(): void;
  onParentAgentEnd(messages: readonly { role: string; stopReason?: string; errorMessage?: string }[]): void;
  onParentSettled(): void;
  restorePending(): void;
  onSessionTree(): void;
  pendingResultCount(): number | undefined;
  getStoredResult(agentId: string): PendingResult | undefined;
  markResultPresented(deliveryId: string): void;
  dispose(): void;
}

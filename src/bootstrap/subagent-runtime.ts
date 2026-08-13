import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createSubagentRuntime,
  type ConcurrencyLimits,
  type SubagentRuntime,
} from "../modules/subagent-runtime/public.js";
import { createPiSessionDriver } from "../platform/pi/session-driver.js";
import { createFsWorktreeInspector } from "../platform/fs/worktree-inspector.js";
import {
  createCryptoIdGenerator,
  createNodeScheduler,
  createSystemClock,
} from "../platform/process/runtime-services.js";

export function createHostSubagentRuntime(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  limits?: {
    default: number;
    models?: Record<string, number>;
    providers?: Record<string, number>;
  };
}): SubagentRuntime {
  const modelLimits: Record<string, number> = {};
  const providerLimits: Record<string, number> = {};
  for (const [key, limit] of Object.entries(options.limits?.models ?? {})) {
    modelLimits[key] = Math.max(1, limit);
  }
  for (const [key, limit] of Object.entries(options.limits?.providers ?? {})) {
    providerLimits[key] = Math.max(1, limit);
  }
  const limits: ConcurrencyLimits = {
    defaultModelLimit: Math.max(1, options.limits?.default ?? 4),
    modelLimits,
    providerLimits,
  };

  return createSubagentRuntime({
    sessionDriver: createPiSessionDriver({ pi: options.pi, ctx: options.ctx }),
    worktreeInspector: createFsWorktreeInspector(options.pi),
    clock: createSystemClock(),
    ids: createCryptoIdGenerator(),
    scheduler: createNodeScheduler(),
    limits,
  });
}

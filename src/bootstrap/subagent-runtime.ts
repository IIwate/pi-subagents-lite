import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createSubagentRuntime,
  DEFAULT_CONCURRENCY_LIMIT,
  type ConcurrencyLimits,
  type SubagentRuntime,
} from "../modules/subagent-runtime/public.js";
import { createPiSessionDriver } from "../platform/pi/session-driver.js";
import {
  createCryptoIdGenerator,
  createNodeScheduler,
  createSystemClock,
} from "../platform/process/runtime-services.js";
import { customPromptPath, skillsUserHome } from "./configuration.js";

export function createHostSubagentRuntime(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Canonical scheduler limits; the runtime's fragment parser guarantees the >= 1 invariant. */
  limits?: ConcurrencyLimits;
}): SubagentRuntime {
  const limits: ConcurrencyLimits = options.limits
    ?? { defaultModelLimit: DEFAULT_CONCURRENCY_LIMIT, modelLimits: {}, providerLimits: {} };

  return createSubagentRuntime({
    sessionDriver: createPiSessionDriver({
      pi: options.pi,
      ctx: options.ctx,
      customPromptPath,
      homeDirectory: skillsUserHome,
    }),
    clock: createSystemClock(),
    ids: createCryptoIdGenerator(),
    scheduler: createNodeScheduler(),
    limits,
  });
}

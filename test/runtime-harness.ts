import {
  createSubagentRuntime,
  type SubagentRuntime,
} from "../src/modules/subagent-runtime/public.js";
import { createPiSessionDriver } from "../src/platform/pi/session-driver.js";
import { createCryptoIdGenerator } from "../src/platform/process/runtime-services.js";

/** Host-shaped runtime for integration tests that still drive Pi session adapters. */
export function createTestSubagentRuntime(options: {
  pi: any;
  ctx: any;
  clock?: { now(): number };
  defaultModelLimit?: number;
}): SubagentRuntime {
  return createSubagentRuntime({
    sessionDriver: createPiSessionDriver({ pi: options.pi, ctx: options.ctx }),
    worktreeInspector: {
      async inspect(request) {
        return { ok: true, resolvedPath: request.worktreePath };
      },
    },
    clock: options.clock ?? { now: () => Date.now() },
    ids: createCryptoIdGenerator(),
    scheduler: {
      interval: () => ({ clear() {} }),
      timeout: () => ({ clear() {} }),
    },
    limits: {
      defaultModelLimit: options.defaultModelLimit ?? 4,
      modelLimits: {},
      providerLimits: {},
    },
  });
}

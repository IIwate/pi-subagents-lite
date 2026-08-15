import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSubagentRuntime,
  type SessionDriver,
  type SubagentRuntime,
} from "../src/modules/subagent-runtime/public.js";
import { createPiSessionDriver } from "../src/platform/pi/session-driver.js";
import { createCryptoIdGenerator } from "../src/platform/process/runtime-services.js";

type StartRequest = Parameters<SessionDriver["start"]>[0];
type ContinueRequest = Parameters<SessionDriver["continueRun"]>[0];

/** Outcome of one scripted provider run. */
export interface ScriptedRunOutcome {
  responseText: string;
  aborted?: boolean;
  turnLimited?: boolean;
}

export interface ScriptedSessionDriverOptions {
  /**
   * One scripted run per start command. Call ready() to emit session-ready
   * (the runtime marks the session live); throw afterwards to simulate a
   * provider failure on an already-live session.
   */
  start: (request: StartRequest, ready: () => void) => Promise<ScriptedRunOutcome>;
  /** Scripted continuation; tests that never interact can omit it. */
  continueRun?: (request: ContinueRequest) => Promise<ScriptedRunOutcome>;
}

/**
 * SessionDriver port double for delivery-focused integration tests. The
 * provider conversation is out of scope there; what matters is that runs
 * settle with scripted results and inspect() reports live sessions, so
 * settled continuations stay reachable.
 */
export function createScriptedSessionDriver(script: ScriptedSessionDriverOptions): SessionDriver {
  const live = new Set<string>();
  return {
    async start(request, emit) {
      const ready = () => {
        live.add(request.sessionId);
        emit({
          type: "session-ready",
          agentId: request.agentId,
          sessionId: request.sessionId,
          modelId: request.acceptedPolicy.model.id,
          provider: request.acceptedPolicy.model.provider,
        });
      };
      const outcome = await script.start(request, ready);
      live.add(request.sessionId);
      emit({
        type: "completed",
        agentId: request.agentId,
        sessionId: request.sessionId,
        responseText: outcome.responseText,
        aborted: outcome.aborted ?? false,
        turnLimited: outcome.turnLimited ?? false,
      });
    },
    async continueRun(request, emit) {
      if (!script.continueRun) {
        emit({
          type: "failed",
          agentId: request.agentId,
          sessionId: request.sessionId,
          error: "No scripted continuation.",
        });
        return;
      }
      const outcome = await script.continueRun(request);
      emit({
        type: "completed",
        agentId: request.agentId,
        sessionId: request.sessionId,
        responseText: outcome.responseText,
        aborted: outcome.aborted ?? false,
        turnLimited: outcome.turnLimited ?? false,
      });
    },
    async steer() {
      return { accepted: false };
    },
    async abort() {},
    async close(request) {
      live.delete(request.sessionId);
    },
    inspect(request) {
      return live.has(request.sessionId)
        ? { found: true, live: true, streaming: false, messages: [] }
        : { found: false, live: false, streaming: false, messages: [] };
    },
    inspectStream(request) {
      return live.has(request.sessionId)
        ? { found: true, live: true, streaming: false }
        : { found: false, live: false, streaming: false };
    },
  };
}

/**
 * An empty home for user-level skill and prompt lookups. Created per process so
 * a suite can never pick up the developer's own `~/.agents` skills, which would
 * make prompt assertions depend on the machine running them.
 */
let emptyHome: string | undefined;
function isolatedHome(): string {
  emptyHome ??= mkdtempSync(join(tmpdir(), "runtime-harness-home-"));
  return emptyHome;
}

/** Host-shaped runtime for integration tests. Defaults to the real Pi session driver. */
export function createTestSubagentRuntime(options: {
  pi?: any;
  ctx?: any;
  sessionDriver?: SessionDriver;
  clock?: { now(): number };
  defaultModelLimit?: number;
  /** Resolved home for user-level skill discovery; defaults to an empty temp dir. */
  homeDirectory?: string;
  /** Custom system-prompt file; defaults to a path under the empty home. */
  customPromptPath?: string;
}): SubagentRuntime {
  const homeDirectory = options.homeDirectory ?? isolatedHome();
  return createSubagentRuntime({
    sessionDriver: options.sessionDriver
      ?? createPiSessionDriver({
        pi: options.pi,
        ctx: options.ctx,
        homeDirectory,
        customPromptPath: options.customPromptPath
          ?? join(homeDirectory, ".pi", "agent", "subagents-lite-prompt.md"),
      }),
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

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  type SessionDriver,
  type SessionEvent,
  type SessionInspectResult,
} from "../../modules/subagent-runtime/public.js";
import { getSessionContextPercent } from "../../agents/usage.js";
import { continueAgentSession, runAgent } from "./agent-session.js";

export interface CreatePiSessionDriverOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  teardownTimeoutMs?: number;
}

interface LiveSession {
  session: AgentSession;
}

function asImages(images: unknown[] | undefined): ImageContent[] | undefined {
  return images?.length ? images as ImageContent[] : undefined;
}

export function createPiSessionDriver(options: CreatePiSessionDriverOptions): SessionDriver {
  const sessions = new Map<string, LiveSession>();
  const closed = new WeakSet<AgentSession>();
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;

  const inspect = (sessionId: string): SessionInspectResult => {
    const live = sessions.get(sessionId);
    if (!live) return { found: false, live: false, streaming: false, messages: [] };
    const session = live.session;
    const streamingMessage = (session.agent?.state as { streamingMessage?: unknown } | undefined)?.streamingMessage;
    return {
      found: true,
      live: true,
      streaming: session.isStreaming,
      modelId: session.model?.id,
      provider: session.model?.provider,
      thinkingLevel: session.thinkingLevel,
      contextPercent: getSessionContextPercent(session),
      messages: Array.isArray(session.messages)
        ? [...(session.messages as unknown as SessionInspectResult["messages"])]
        : [],
      streamingMessage: streamingMessage as unknown as SessionInspectResult["streamingMessage"],
    };
  };

  return {
    async start(request, emit) {
      const result = await runAgent(options.ctx, request.agentType, request.prompt, {
        pi: options.pi,
        agentId: request.agentId,
        acceptedPolicy: request.acceptedPolicy,
        cwd: request.worktreePath,
        debugFault: request.debugFault,
        onSessionSetupStarted: () => {
          emit({ type: "setup-started", agentId: request.agentId, sessionId: request.sessionId });
        },
        onSessionSetupFinished: () => {
          emit({ type: "setup-finished", agentId: request.agentId, sessionId: request.sessionId });
        },
        onSessionCreated: (session) => {
          sessions.set(request.sessionId, { session });
          emit({
            type: "session-ready",
            agentId: request.agentId,
            sessionId: request.sessionId,
            modelId: session.model?.id,
            provider: session.model?.provider,
            thinkingLevel: session.thinkingLevel,
          });
        },
        onToolUse: () => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, toolUse: true });
        },
        onAssistantUsage: (usage) => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, usage });
        },
        onCompaction: () => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, compaction: true });
        },
        onTurnEnd: (turnCount) => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, turnCount });
        },
      });
      sessions.set(request.sessionId, { session: result.session });
      emit({
        type: "completed",
        agentId: request.agentId,
        sessionId: request.sessionId,
        responseText: result.responseText,
        aborted: result.aborted,
        turnLimited: result.turnLimited,
        contextPercent: getSessionContextPercent(result.session),
      });
    },
    async continueRun(request, emit) {
      const live = sessions.get(request.sessionId);
      if (!live) {
        emit({
          type: "failed",
          agentId: request.agentId,
          sessionId: request.sessionId,
          error: "Session is no longer live.",
        });
        return;
      }
      const result = await continueAgentSession(live.session, request.prompt, {
        images: asImages(request.images),
        maxTurns: request.maxTurns,
        graceTurns: request.graceTurns,
        onToolUse: () => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, toolUse: true });
        },
        onAssistantUsage: (usage) => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, usage });
        },
        onCompaction: () => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, compaction: true });
        },
        onTurnEnd: (turnCount) => {
          emit({ type: "progress", agentId: request.agentId, sessionId: request.sessionId, turnCount });
        },
      });
      emit({
        type: "completed",
        agentId: request.agentId,
        sessionId: request.sessionId,
        responseText: result.responseText,
        aborted: result.aborted,
        turnLimited: result.turnLimited,
        contextPercent: getSessionContextPercent(live.session),
      });
    },
    async steer(request) {
      const live = sessions.get(request.sessionId);
      if (!live) return { accepted: false };
      try {
        await live.session.steer(request.message, asImages(request.images));
        return { accepted: true };
      } catch {
        return { accepted: false };
      }
    },
    async abort(request) {
      const live = sessions.get(request.sessionId);
      if (!live) return;
      try {
        await live.session.abort();
      } catch {
        // Teardown abort is best effort; the runtime already marked the snapshot stopped.
      }
    },
    async close(request) {
      const live = sessions.get(request.sessionId);
      sessions.delete(request.sessionId);
      if (!live || closed.has(live.session)) return;
      closed.add(live.session);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          live.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, teardownTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        live.session.dispose();
      }
    },
    inspect(request) {
      return inspect(request.sessionId);
    },
  };
}

export type { SessionEvent };

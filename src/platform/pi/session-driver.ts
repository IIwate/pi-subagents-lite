import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TEARDOWN_TIMEOUT_MS,
  type SessionDriver,
  type SessionInspectResult,
  type SessionStreamResult,
} from "../../modules/subagent-runtime/public.js";
import { getSessionContextPercent } from "./usage.js";
import { parseThinkingLevel } from "../../utils.js";
import { continueAgentSession, runAgent } from "./agent-session.js";

export interface CreatePiSessionDriverOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Absolute path of the optional custom system-prompt file for "custom" mode. */
  customPromptPath: string;
  /** Resolved home directory used for user-level skill discovery. */
  homeDirectory: string;
  teardownTimeoutMs?: number;
}

interface LiveSession {
  session: AgentSession;
}

function asImages(images: unknown[] | undefined): ImageContent[] | undefined {
  return images?.length ? images as ImageContent[] : undefined;
}

/**
 * Context% is a session-stat, not a transcript. Putting it on progress
 * keeps the list timer from inspecting every child's messages just to
 * paint a percentage. The number is whatever getSessionStats says at
 * this event; a quiet stream between events will look frozen until the
 * next tool, usage, compaction, or turn. Revisit if the list needs
 * sub-event freshness without opening the transcript.
 */
function progressEvent(
  agentId: string,
  sessionId: string,
  session: AgentSession | undefined,
  extra: {
    toolUse?: boolean;
    usage?: { input: number; output: number; cacheWrite: number; cost: number };
    compaction?: boolean;
    turnCount?: number;
  },
) {
  return {
    type: "progress" as const,
    agentId,
    sessionId,
    ...extra,
    contextPercent: getSessionContextPercent(session),
  };
}

/**
 * The transcript is the one bulk payload leaving this adapter, and Pi's message
 * objects are host types, not JSON: optional fields hold `undefined`, and
 * nothing stops a future field from holding something worse. Serializing once
 * here makes the value what the port contract says it is; a cast would leave
 * the receiving check to reject the whole record set over one field it never
 * needed.
 */
function asPortResult(result: unknown): SessionInspectResult {
  return JSON.parse(JSON.stringify(result)) as SessionInspectResult;
}

export function createPiSessionDriver(options: CreatePiSessionDriverOptions): SessionDriver {
  const sessions = new Map<string, LiveSession>();
  const closed = new WeakSet<AgentSession>();
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  /**
   * Cancellation must exist before the live-session map. Setup can spend
   * seconds loading resources before onSessionCreated; without this map, a
   * stopped parent still sends the child's first provider prompt. AbortSignal
   * remains platform state and never enters the serialized driver contract.
   */
  const setupAborts = new Map<string, AbortController>();

  const streamingMessageOf = (session: AgentSession): unknown =>
    (session.agent?.state as { streamingMessage?: unknown } | undefined)?.streamingMessage;

  const inspect = (sessionId: string): SessionInspectResult => {
    const live = sessions.get(sessionId);
    if (!live) return { found: false, live: false, streaming: false, messages: [] };
    const session = live.session;
    const streamingMessage = streamingMessageOf(session);
    return asPortResult({
      found: true,
      live: true,
      streaming: session.isStreaming,
      modelId: session.model?.id,
      provider: session.model?.provider,
      thinkingLevel: parseThinkingLevel(session.thinkingLevel),
      contextPercent: getSessionContextPercent(session),
      messages: Array.isArray(session.messages) ? [...session.messages] : [],
      streamingMessage,
    });
  };

  /**
   * Serialize only the current streaming message. Stable history remains on
   * inspect, so a refresh costs the same after ten messages or ten thousand.
   */
  const inspectStream = (sessionId: string): SessionStreamResult => {
    const live = sessions.get(sessionId);
    if (!live) return { found: false, live: false, streaming: false };
    const session = live.session;
    return JSON.parse(JSON.stringify({
      found: true,
      live: true,
      streaming: session.isStreaming,
      streamingMessage: streamingMessageOf(session),
    })) as SessionStreamResult;
  };

  return {
    async start(request, emit) {
      // Register before any await; the first suspension is already late enough.
      const setupAbort = new AbortController();
      setupAborts.get(request.sessionId)?.abort();
      setupAborts.set(request.sessionId, setupAbort);
      let liveSession: AgentSession | undefined;
      try {
        const result = await runAgent(options.ctx, request.agentType, request.prompt, {
          pi: options.pi,
          agentId: request.agentId,
          acceptedPolicy: request.acceptedPolicy,
          customPromptPath: options.customPromptPath,
          homeDirectory: options.homeDirectory,
          cwd: request.worktreePath,
          signal: setupAbort.signal,
          debugFault: request.debugFault,
          onSessionSetupStarted: () => {
            emit({ type: "setup-started", agentId: request.agentId, sessionId: request.sessionId });
          },
          onSessionSetupFinished: () => {
            emit({ type: "setup-finished", agentId: request.agentId, sessionId: request.sessionId });
          },
          onSessionCreated: (session) => {
            liveSession = session;
            sessions.set(request.sessionId, { session });
            emit({
              type: "session-ready",
              agentId: request.agentId,
              sessionId: request.sessionId,
              modelId: session.model?.id,
              provider: session.model?.provider,
              // Pi reports whatever the model exposes; the port contract accepts
              // only the canonical set, so an unrecognized level is dropped here
              // instead of being rejected as a whole session-ready event.
              thinkingLevel: parseThinkingLevel(session.thinkingLevel),
            });
          },
          onToolUse: () => {
            emit(progressEvent(request.agentId, request.sessionId, liveSession, { toolUse: true }));
          },
          onAssistantUsage: (usage) => {
            emit(progressEvent(request.agentId, request.sessionId, liveSession, { usage }));
          },
          onCompaction: () => {
            emit(progressEvent(request.agentId, request.sessionId, liveSession, { compaction: true }));
          },
          onTurnEnd: (turnCount) => {
            emit(progressEvent(request.agentId, request.sessionId, liveSession, { turnCount }));
          },
        });
        // Close may erase the session while an aborted prompt is still
        // draining. Only the start that still owns this controller may put
        // the handle back; otherwise cleanup ends with a live ghost.
        if (
          setupAborts.get(request.sessionId) === setupAbort
          && !setupAbort.signal.aborted
        ) {
          sessions.set(request.sessionId, { session: result.session });
        }
        emit({
          type: "completed",
          agentId: request.agentId,
          sessionId: request.sessionId,
          responseText: result.responseText,
          aborted: result.aborted,
          turnLimited: result.turnLimited,
          contextPercent: getSessionContextPercent(result.session),
        });
      } finally {
        // Clear only the controller this start owns; close or a later start may
        // already have replaced it.
        if (setupAborts.get(request.sessionId) === setupAbort) {
          setupAborts.delete(request.sessionId);
        }
      }
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
          emit(progressEvent(request.agentId, request.sessionId, live.session, { toolUse: true }));
        },
        onAssistantUsage: (usage) => {
          emit(progressEvent(request.agentId, request.sessionId, live.session, { usage }));
        },
        onCompaction: () => {
          emit(progressEvent(request.agentId, request.sessionId, live.session, { compaction: true }));
        },
        onTurnEnd: (turnCount) => {
          emit(progressEvent(request.agentId, request.sessionId, live.session, { turnCount }));
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
      // While start is in flight, the controller is the one abort path. Once
      // a session is live its signal listener owns abort(); calling the live
      // handle here as well would make one stop arrive twice.
      const setupAbort = setupAborts.get(request.sessionId);
      if (setupAbort) {
        setupAbort.abort();
        return;
      }
      const live = sessions.get(request.sessionId);
      if (!live) return;
      try {
        await live.session.abort();
      } catch {
        // Teardown abort is best effort; the runtime already marked the snapshot stopped.
      }
    },
    async close(request) {
      // Close must also stop setup; a late prompt would resurrect what cleanup
      // just removed.
      setupAborts.get(request.sessionId)?.abort();
      setupAborts.delete(request.sessionId);
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
    inspectStream(request) {
      return inspectStream(request.sessionId);
    },
  };
}

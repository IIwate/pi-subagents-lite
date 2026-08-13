import type {
  SessionAbortRequest,
  SessionCloseRequest,
  SessionContinueRequest,
  SessionEvent,
  SessionInspectRequest,
  SessionInspectResult,
  SessionStartRequest,
  SessionSteerRequest,
  SessionSteerResult,
} from "../contracts/session.js";

export type SessionEventSink = (event: SessionEvent) => void;

export interface SessionDriver {
  start(request: SessionStartRequest, emit: SessionEventSink): Promise<void>;
  continueRun(request: SessionContinueRequest, emit: SessionEventSink): Promise<void>;
  steer(request: SessionSteerRequest): Promise<SessionSteerResult>;
  abort(request: SessionAbortRequest): Promise<void>;
  close(request: SessionCloseRequest): Promise<void>;
  inspect(request: SessionInspectRequest): SessionInspectResult;
}

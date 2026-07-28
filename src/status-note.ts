import type { AgentLifecycle, AgentStatus, StopInitiator } from "./types.js";

const STATUS_NOTES: Partial<Record<AgentStatus, string>> = {
  // Verbose on purpose. A hard abort is the one terminal state where the parent
  // gets no final answer and nobody chose to stop the agent — it overran an
  // internal budget the parent never saw. The old wording ("output may be
  // incomplete") implied output existed; usually none does, and any text that
  // survives is whatever the model happened to be saying mid-task. Spelling out
  // the cause and the remedy costs tokens only on this rare path.
  aborted:
    "HARD-STOPPED: the agent burned through its turn budget without producing a final answer. Any text above is a mid-task fragment, not a conclusion — do not treat it as the result. Re-dispatch with a narrower scope, or raise this agent type's max_turns",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

const STOP_NOTES: Record<StopInitiator, string> = {
  user: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  agent: "stopped before completion — output is partial; the task was NOT finished",
};

export function getStatusNote(lifecycle: AgentLifecycle): string {
  const note =
    lifecycle.status === "stopped"
      // A stopped agent with no recorded initiator reads as an agent stop.
      ? STOP_NOTES[lifecycle.stoppedBy ?? "agent"]
      : STATUS_NOTES[lifecycle.status];
  return note ? ` (${note})` : "";
}

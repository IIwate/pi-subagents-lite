import type { TaskOutcome } from "../domain/task.js";

const STATUS_NOTES: Partial<Record<TaskOutcome["status"], string>> = {
  // A hard abort can leave only mid-task fragments. Explain that they are not a
  // conclusion and give the parent a way to recover from the exhausted budget.
  aborted:
    "HARD-STOPPED: the agent burned through its turn budget without producing a final answer. Any text above is a mid-task fragment, not a conclusion — do not treat it as the result. Re-dispatch with a narrower scope, or raise this agent type's max_turns",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

const STOP_NOTES = {
  user: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  agent: "stopped before completion — output is partial; the task was NOT finished",
};

export function getStatusNote(outcome: TaskOutcome): string {
  const note =
    outcome.status === "stopped"
      // A stopped agent with no recorded initiator reads as an agent stop.
      ? STOP_NOTES[outcome.stoppedBy ?? "agent"]
      : STATUS_NOTES[outcome.status];
  return note ? ` (${note})` : "";
}

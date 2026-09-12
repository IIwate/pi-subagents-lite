import { freezePolicy, type TaskPolicy } from "./policy.js";

export type TaskOutcome =
  | { readonly status: "completed" | "turn_limited"; readonly result: string }
  | { readonly status: "error"; readonly error: string; readonly result?: string }
  | { readonly status: "aborted" | "stopped"; readonly result?: string; readonly stoppedBy?: "user" | "agent" };

export type TaskState =
  | { readonly status: "queued" | "running" | "waiting" | "cancelling" }
  | { readonly status: "settled"; readonly outcome: TaskOutcome };

// Note: see .agents/notes/implemented/architecture/2026-09-11-task-policy-and-quota-domain.md
export interface Task {
  readonly taskId: string;
  readonly operationId: string;
  readonly policy: TaskPolicy;
  readonly control: "autonomous" | "manual";
  readonly state: TaskState;
}

export type TaskEvent =
  | { readonly type: "started" | "waiting" | "cancel_requested"; readonly operationId: string }
  | { readonly type: "settled"; readonly operationId: string; readonly outcome: TaskOutcome }
  | { readonly type: "takeover" }
  | { readonly type: "continue"; readonly operationId: string };

export function createTask(taskId: string, operationId: string, policy: TaskPolicy): Task {
  return Object.freeze({
    taskId,
    operationId,
    policy: freezePolicy(policy),
    control: "autonomous",
    state: Object.freeze({ status: "queued" }),
  });
}

/** Lifecycle events describe driver facts; input queueing does not change control. */
export function reduceTask(task: Task, event: TaskEvent): Task {
  if (event.type === "takeover") {
    return task.control === "manual" ? task : Object.freeze({ ...task, control: "manual" });
  }

  if (event.type === "continue") {
    if (task.state.status !== "settled") throw new Error("Task must settle before starting another operation");
    if (event.operationId === task.operationId) throw new Error("Continuation requires a new operation ID");
    return Object.freeze({
      ...task,
      operationId: event.operationId,
      state: Object.freeze({ status: "queued" }),
    });
  }

  if (event.operationId !== task.operationId || task.state.status === "settled") return task;

  if (event.type === "settled") {
    return Object.freeze({
      ...task,
      state: Object.freeze({ status: "settled", outcome: Object.freeze({ ...event.outcome }) }),
    });
  }

  // Progress cannot undo an accepted cancellation; only the driver's terminal outcome settles it.
  if (task.state.status === "cancelling") return task;
  const status = event.type === "started" ? "running" : event.type === "waiting" ? "waiting" : "cancelling";
  return task.state.status === status ? task : Object.freeze({ ...task, state: Object.freeze({ status }) });
}

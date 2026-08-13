import type {
  WorktreeInspectRequest,
  WorktreeInspectResult,
} from "../contracts/worktree.js";

export interface WorktreeInspector {
  inspect(request: WorktreeInspectRequest): Promise<WorktreeInspectResult>;
}

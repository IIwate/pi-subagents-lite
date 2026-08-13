import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorktreeInspector } from "../../modules/subagent-runtime/public.js";
import { validateWorktreePath } from "../../spawn/worktree-validator.js";

export function createFsWorktreeInspector(
  pi: Pick<ExtensionAPI, "exec">,
  onWarning?: (message: string) => void,
): WorktreeInspector {
  return {
    inspect: (request) => validateWorktreePath(pi, request.worktreePath, request.parentCwd, onWarning),
  };
}

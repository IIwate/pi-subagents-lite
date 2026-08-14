import type { WorktreeInspector } from "../../modules/subagent-runtime/public.js";
import { validateWorktreePath, type CommandRunner } from "./worktree-validator.js";

/**
 * The WorktreeInspector port over the local filesystem and git.
 *
 * Diagnostics from the git probes are returned with the result instead of being
 * pushed through a callback: the port must stay serializable, and the caller
 * decides whether a probe failure is worth showing a user.
 */
export function createFsWorktreeInspector(runner: CommandRunner): WorktreeInspector {
  return {
    async inspect(request) {
      const warnings: string[] = [];
      const result = await validateWorktreePath(
        runner,
        request.worktreePath,
        request.parentCwd,
        (message) => { warnings.push(message); },
      );
      return warnings.length > 0 ? { ...result, warnings } : result;
    },
  };
}

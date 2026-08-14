import { Type, type Static } from "typebox";

export const WorktreeInspectRequestSchema = Type.Object({
  worktreePath: Type.String(),
  parentCwd: Type.String(),
}, { additionalProperties: false });

/**
 * Warnings are returned rather than pushed through a callback: a function
 * cannot cross a port that must stay serializable, and the caller decides
 * whether a diagnostic is worth showing (today only a rejected path surfaces
 * them, so a callback would have notified on success too).
 */
export const WorktreeInspectResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    resolvedPath: Type.Optional(Type.String()),
    warnings: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.String(),
    warnings: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false }),
]);

export type WorktreeInspectRequest = Static<typeof WorktreeInspectRequestSchema>;
export type WorktreeInspectResult = Static<typeof WorktreeInspectResultSchema>;

import { Type, type Static } from "typebox";

export const WorktreeInspectRequestSchema = Type.Object({
  worktreePath: Type.String(),
  parentCwd: Type.String(),
}, { additionalProperties: false });

export const WorktreeInspectResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    resolvedPath: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.String(),
  }, { additionalProperties: false }),
]);

export type WorktreeInspectRequest = Static<typeof WorktreeInspectRequestSchema>;
export type WorktreeInspectResult = Static<typeof WorktreeInspectResultSchema>;

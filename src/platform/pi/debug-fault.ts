import {
  DebugFaultKindSchema,
  type DebugFaultKind,
} from "../../modules/subagent-runtime/public.js";

export type { DebugFaultKind };

/**
 * Messages stay here because the runner throws them after session setup.
 * The kind list does not: a second handwritten union is how a settings
 * page could arm a label this adapter has no sentence for. Kinds come
 * from the runtime schema; a new literal fails `satisfies` until a
 * message exists. Revisit if diagnostics grow a structured fault object.
 */
const DEBUG_FAULT_KINDS = DebugFaultKindSchema.anyOf.map(
  (member) => member.const,
) as readonly DebugFaultKind[];

const DEBUG_FAULT_MESSAGES = {
  output_blocked: "debug injected: content was flagged",
  provider_error: "debug injected: provider error after session setup",
} as const satisfies Record<(typeof DEBUG_FAULT_KINDS)[number], string>;

export function debugFaultMessage(kind: DebugFaultKind): string {
  if (!DEBUG_FAULT_KINDS.includes(kind)) {
    throw new TypeError("Debug fault kind does not match its contract.");
  }
  return DEBUG_FAULT_MESSAGES[kind];
}

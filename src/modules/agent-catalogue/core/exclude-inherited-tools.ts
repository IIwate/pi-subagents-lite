/**
 * A Subagent that can call Agent can start another Subagent, and that chain
 * has no depth ceiling, no shared concurrency budget, and no path back to
 * the human who authorized the first call. The name is stripped here so a
 * definition that writes it down is refused the same way as one that
 * inherits the host roster. Revisit when nested spawn has a bound and a
 * delivery path.
 */
const INHERITED_AGENT_TOOL_NAME = "Agent";

export function excludeInheritedTools(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => name !== INHERITED_AGENT_TOOL_NAME);
}

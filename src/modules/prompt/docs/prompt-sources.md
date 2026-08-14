# Prompt source and assembly specification

`prompt` is an internal support module. This document makes extension-controlled prompt material easy to inspect and change in source; it does not define a user-facing inspection feature.

## Outputs

| Output | Consumer | Inputs |
|:--|:--|:--|
| Agent guidance | Parent LLM before eligible Agent use | Effective Agent catalogue and Model access projections |
| Subagent system prompt | Isolated Subagent session | Accepted Agent definition, prompt mode, skills, context files, runtime environment, and accepted run policy |

## Source ownership

- Static guidance headers and rules belong to the prompt module source.
- Agent-specific guidance data comes from a serialized catalogue snapshot.
- Model-related guidance comes from the effective Model access snapshot.
- Custom prompt content and context files are read by `platform/fs` and passed as strings.
- Pi parent prompt text is supplied by the host callback and never stored in prompt state.

## Ordering and determinism

Each output has a documented ordered fragment list. Assembly is a pure function of its serialized request. The same JSON request produces byte-identical output. Optional sources are represented explicitly; no hidden refresh, time, random ID, or process-global state is allowed.

### Agent guidance order

1. `[Subagent access]` header
2. Available agent types, sorted by name, with parent-default or required-`model` details
3. Unavailable agent types, if any
4. Static Agent tool rules
5. Per-agent exact alternate model keys and Thinking summaries

### Subagent system prompt order

1. Mode header: replace default, inherited parent text, or custom file text (scaffolding stripped)
2. Runtime environment block
3. Serialized project context files
4. `<active_agent>` tag
5. `<agent_instructions>` from the accepted Agent definition
6. Skill elements supplied by the host

The host owns Pi skill XML formatting and filesystem reads. Prompt assembly only concatenates those serialized strings.

## Failure boundaries

A prompt source that fails to resolve is not silently replaced by a different mode. The host distinguishes two cases:

- Inherited parent text is supplied by the host callback. If that callback throws, or the supplied text is missing, empty, whitespace-only, or only parent scaffolding (date/cwd/project/skill blocks that strip to nothing), the run fails. The condition is a host malfunction the user cannot see or correct, and an inherited persona is the reason the mode was chosen — work produced under a generic header would still be reported as a success.
- The custom prompt file is a state the settings page shows and offers to create. An absent or unreadable file degrades to replace mode with a notice, keeping the delegation alive over a condition the user already owns.

## Owning tests

| Fragment or rule | Owner | Public-seam test |
|:--|:--|:--|
| Guidance header, tool rules, required `model`, exact alternates | `assemble-guidance.ts` | `test/modules/prompt/assemble-guidance.test.ts` required-model golden |
| Guidance name sort, unavailable types, `maxTurns` | `assemble-guidance.ts` | `test/modules/prompt/assemble-guidance.test.ts` sort/unavailable |
| Guidance malformed command | `assemble-agent-guidance.ts` | `test/modules/prompt/assemble-guidance.test.ts` invalid-command |
| Catalogue reader for Parent guidance | `create-parent-guidance.ts` | `test/modules/prompt/parent-guidance.test.ts` |
| Replace-mode env, context, skill wrapper | `assemble-subagent-prompt.ts` | `test/modules/prompt/assemble-subagent-prompt.test.ts` replace golden |
| Inherit scaffolding strip | `assemble-subagent-prompt.ts` | inherit date/cwd strip |
| Inherit missing, empty, or whitespace header | `assemble-subagent-prompt.ts` | inherit unavailable header |
| Inherit header that strips to empty | `assemble-subagent-prompt.ts` | inherit scaffolding-only header |
| Custom header and leftover context/skill strip | `assemble-subagent-prompt.ts` | custom scaffolding strip |
| Replace mode ignores host header | `assemble-subagent-prompt.ts` | replace ignores header |
| Subagent malformed command | `assemble-subagent-prompt.ts` | invalid-command |
| Custom file and context I/O | `platform/fs/prompt-files.ts` | `test/platform/fs/prompt-files.test.ts` |

## Safety boundary

Prompt text is not persisted as a runtime record, emitted as a new session message, logged for inspection, or exposed through a new menu or command. Users inspect and modify extension-controlled material through the source files and these documents.

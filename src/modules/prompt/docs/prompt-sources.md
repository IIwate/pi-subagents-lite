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

## Safety boundary

Prompt text is not persisted as a runtime record, emitted as a new session message, logged for inspection, or exposed through a new menu or command. Users inspect and modify extension-controlled material through the source files and these documents.

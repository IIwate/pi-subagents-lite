# Changelog

## 3.0.0

Subagents use native Pi Harness execution with isolated runtimes and durable result delivery on the unmodified official Pi host.

### Breaking changes

- Requires Pi 0.85.1 and Node.js 22.19+.
- Settings use `subagents-lite-v3.json` in Pi's agent directory. Configure v3 through `/agents`; v2 settings are not imported. Existing v3 files with invalid JSON, unknown fields, or invalid values fail visibly.
- Native tasks use `subagents-lite-v3/sessions`. v2 unfinished tasks and undelivered results are not restored; finish pending work before upgrading.
- Ordinary input in a subagent queues steering and preserves automatic delivery. Use `Alt+T` for explicit takeover, then select output with `Alt+S` while the list is focused.

### Features

- Reload discovers native tasks and saved results for the current parent session. Input in a waiting task resumes its accepted operation; input in a settled task starts another operation under its accepted policy.
- Runtime instances independently own configuration, agent definitions, quotas, execution resources, and navigation. Accepted tasks retain their model, tools, prompt, limits, and execution mode.
- Background results retain their parent session and branch origin. A result is acknowledged only after its receipt persists in the parent log; failed delivery retains the saved result.
- Force background applies directly to every new Agent call, including omitted or false `run_in_background` values. English guidance follows the setting on the next parent turn.

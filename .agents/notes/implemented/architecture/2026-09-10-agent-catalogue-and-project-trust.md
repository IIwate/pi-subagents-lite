# Agent Note: Agent 定义发现、覆盖与项目信任

Status: implemented

## Problem

内建 Agent、用户定义和项目定义需要明确的覆盖次序, 且用户在会话期间增加定义后应能调用. 将未指定字段提前填成 false 会覆盖全局加载偏好; 将工作树同仓库校验视为项目授权, 又会把可执行定义的信任判定交给路径关系.

## Decision

[discovery](../../../../src/agents/agent-discovery.ts) 按文件名顺序扫描目录顶层普通 `.md` 文件, 使用 Pi YAML parser 和 Agent 字段投影. 支持逗号列表、行式数组、带引号的 inline-array 和 CRLF. 仅有 name 的文件进入定义集合. 目录缺失返回空集合, 单文件读取或解析失败报告路径并跳过, 同目录其他有效文件仍可用. [格式和目录契约](../bug-fix/2026-09-10-canonical-agent-resources-and-discovery.md) 负责类型校验和手动迁移规则.

字段覆盖顺序为 built-in < global < project. `undefined` 字段不覆盖较低层, false 和数组保留明确意图; 正文包括空字符串参与覆盖. `skills`/`extensions` 在定义层保留未指定状态, 到接受任务时才应用全局隐式加载默认值. `preload_skills` 仅支持显式名字集合或 false, 不把 true 解释成加载全部正文.

[registry](../../../../src/agents/agent-types.ts) 在 session start 全量建立, 未找到类型时按需 rescan, 只补不存在的名字. worktree 定义最后补入, 不覆盖已注册同名项. 名称依次匹配 exact canonical、唯一 case-fold canonical、唯一 displayName; 同级歧义报告排序后的候选. `hidden` 从 guidance 的可见列表排除, 但精确名字仍可被工具解析. 禁用内建定义只影响后续查找, 不停掉已接受任务, 同名用户定义仍可存在.

[session start](../../../../src/events.ts) 仅在 `ctx.isProjectTrusted?.() !== false` 时传入项目目录; [worktree rescan](../../../../src/agents/tool-execution.ts) 同样检查该门禁. 未可信项目不扫描 project/worktree Agent 文件. 这是 Pi 最终信任结果的负向门禁, 不是本扩展主动发起信任询问; 方法缺失仍放行. [worktree validator](2026-09-09-worktree-path-parameter-naming.md) 仅验证仓库关系, 不授权项目内容.

## Alternatives considered

- **仅启动时扫描.** 定义集稳定且无重复 I/O, 但会话中新增 Agent 必须 reload. 按需发现补足该工作流, 接受删除/编辑已有定义需重新注册的限制.
- **每次查找重新覆盖全部定义.** 文件编辑立即生效, 但会悄悄改变已有 registry 的名字与来源. 当前补充式发现保持会话定义稳定, 已接受策略另由 [快照](2026-09-10-isolated-child-resources-and-tool-gates.md) 固定.
- **加载项目定义只看是否同一仓库.** 不需要 host trust API, 但版本库文件也可能包含未经用户认可的指令和工具策略. 因此信任和 Git 校验分别执行.
- **保留手写 parser 与首项匹配.** 对宽松旧文件最兼容, 但引号、换行和名称碰撞难以给出一致含义. Pi parser 加业务字段投影负责语法, 分层唯一匹配负责名称确定性.

## Consequences

全局目录由 Pi `getAgentDir()` 派生, 项目/worktree 目录使用 `CONFIG_DIR_NAME`. 多个 worktree 仍共享会话补名 registry; 它不提供同名定义的 worktree 隔离. 项目信任不会自动延伸为 skills、上下文文件或 shell 的安全 sandbox.

## Evidence

- `b3bb3aa`, `8888ff7`: 分层定义与 worktree 发现.
- `dae91e5`, `02331a5`, `6401788`, `3f2db10`, `c142abc`: inline-array、preload 限制和未指定/false 的区别.
- `2997e7e`, `f764ed6`: 禁用默认 Agent 对后续查找即时生效.
- `4e5ac95`: 主线 project/worktree trust gate. `b87698b`, `22d9f3c`, `f5b75fc` 位于未合入的 `origin/re`, 仅作为提案依据, 不代表主线已具备其行为.

## Verification

[discovery unit tests](../../../../test/unit/agents/agent-discovery.test.ts)、[definition resolver](../../../../test/unit/agents/agent-types-resolver.test.ts)、[disable defaults](../../../../test/unit/agents/disable-default-agents.test.ts) 验证解析、歧义和覆盖规则. [file discovery](../../../../test/scenarios/agents/agent-file-discovery.test.ts)、[type discovery](../../../../test/scenarios/agents/agent-types-discovery.test.ts)、[events](../../../../test/scenarios/events.test.ts) 和 [Agent tool tests](../../../../test/unit/agents/tool-execution.test.ts) 验证文件、Pi override 与信任入口.

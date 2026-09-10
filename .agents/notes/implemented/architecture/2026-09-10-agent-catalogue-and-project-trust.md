# Agent Note: Agent 定义发现、覆盖与项目信任

Status: implemented

## Problem

内建 Agent、用户定义和项目定义需要明确的覆盖次序, 且用户在会话期间增加定义后应能调用. 将未指定字段提前填成 false 会覆盖全局加载偏好; 将工作树同仓库校验视为项目授权, 又会把可执行定义的信任判定交给路径关系.

## Decision

[discovery](../../../../src/agents/agent-discovery.ts) 扫描目录顶层普通 `.md` 文件, 读取扁平 frontmatter 和正文. 支持逗号列表、行式数组和简单 inline-array, 不宣称完整 YAML 支持. 仅有 name 的文件进入定义集合. 目录缺失返回空集合, 单个文件读取失败跳过, 同目录其他有效文件仍可用.

字段覆盖顺序为 built-in < global < project. `undefined` 字段不覆盖较低层, false 和数组保留明确意图; 正文包括空字符串参与覆盖. `skills`/`extensions` 在定义层保留未指定状态, 到接受任务时才应用全局隐式加载默认值. `preload_skills` 仅支持显式名字集合或 false, 不把 true 解释成加载全部正文.

[registry](../../../../src/agents/agent-types.ts) 在 session start 全量建立, 未找到类型时按需 rescan, 只补不存在的名字. worktree 定义最后补入, 不覆盖已注册同名项. 精确 canonical name 先匹配, 然后按 Map 顺序匹配大小写无关 canonical/displayName. `hidden` 从 guidance 的可见列表排除, 但精确名字仍可被工具解析. 禁用内建定义只影响后续查找, 不停掉已接受任务, 同名用户定义仍可存在.

[session start](../../../../src/events.ts) 仅在 `ctx.isProjectTrusted?.() !== false` 时传入项目目录; [worktree rescan](../../../../src/agents/tool-execution.ts) 同样检查该门禁. 未可信项目不扫描 project/worktree Agent 文件. 这是 Pi 最终信任结果的负向门禁, 不是本扩展主动发起信任询问; 方法缺失仍放行. [worktree validator](2026-09-09-worktree-path-parameter-naming.md) 仅验证仓库关系, 不授权项目内容.

## Alternatives considered

- **仅启动时扫描.** 定义集稳定且无重复 I/O, 但会话中新增 Agent 必须 reload. 按需发现补足该工作流, 接受删除/编辑已有定义需重新注册的限制.
- **每次查找重新覆盖全部定义.** 文件编辑立即生效, 但会悄悄改变已有 registry 的名字与来源. 当前补充式发现保持会话定义稳定, 已接受策略另由 [快照](2026-09-10-isolated-child-resources-and-tool-gates.md) 固定.
- **加载项目定义只看是否同一仓库.** 不需要 host trust API, 但版本库文件也可能包含未经用户认可的指令和工具策略. 因此信任和 Git 校验分别执行.
- **完整 YAML parser 和歧义拒绝.** 能正确处理 CRLF、复杂引号和名称碰撞, 但改变当前宽松格式与解析结果. 当前 parser/查找不是这一方案的等价实现; 具体缺口和收敛路径见 [资源与发现提案](../../proposed/bug-fix/2026-09-10-canonical-agent-resources-and-discovery.md).

## Consequences

当前目录由 HOME 下的 `.pi/agent/agents` 和项目 `.pi/agents` 组成, 与 runner 使用的 Pi `getAgentDir()` 不总相同. 关闭 frontmatter 的 CRLF 分隔识别、大小写/别名碰撞、多个 worktree 共享 registry 均有已知限制, 不应被 Note 描述成确定性解析或完整 host 路径兼容. 项目信任不会自动延伸为 skills、上下文文件或 shell 的安全 sandbox.

## Evidence

- `b3bb3aa`, `8888ff7`: 分层定义与 worktree 发现.
- `dae91e5`, `02331a5`, `6401788`, `3f2db10`, `c142abc`: inline-array、preload 限制和未指定/false 的区别.
- `2997e7e`, `f764ed6`: 禁用默认 Agent 对后续查找即时生效.
- `4e5ac95`: 主线 project/worktree trust gate. `b87698b`, `22d9f3c`, `f5b75fc` 位于未合入的 `origin/re`, 仅作为提案依据, 不代表主线已具备其行为.

## Verification

[discovery unit tests](../../../../test/unit/agents/agent-discovery.test.ts)、[definition resolver](../../../../test/unit/agents/agent-types-resolver.test.ts)、[disable defaults](../../../../test/unit/agents/disable-default-agents.test.ts) 验证已有解析/覆盖规则. [file discovery](../../../../test/scenarios/agents/agent-file-discovery.test.ts)、[type discovery](../../../../test/scenarios/agents/agent-types-discovery.test.ts)、[events](../../../../test/scenarios/events.test.ts) 和 [Agent tool tests](../../../../test/unit/agents/tool-execution.test.ts) 验证文件与信任入口. 这些测试不证明 proposed 中尚未修复的行为.

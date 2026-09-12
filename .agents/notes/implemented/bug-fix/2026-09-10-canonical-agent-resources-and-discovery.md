# Agent Note: Pi 资源目录、YAML 解析与确定性名称解析

Status: implemented

## Problem

配置、定义、技能和子会话若各自推导全局路径, Pi agent directory override 会形成多个资源来源. 手写 frontmatter 的换行和引号处理也会漏掉有效文件; 混合 canonical/alias 查询则让注册顺序决定执行哪个 Agent.

## Decision

配置文件、自定义 prompt、global Agent 目录和 Pi skills 目录均从 Pi getAgentDir() 派生. 项目及 worktree Agent 目录使用 CONFIG_DIR_NAME, 并保留 [项目信任门禁](../architecture/2026-09-10-agent-catalogue-and-project-trust.md). OS home 的 .agents/skills 是独立约定, 不随 Pi 目录 override 改变.

[parseAgentFile](../../../../src/agents/agent-discovery.ts) 使用 Pi 导出的 parseFrontmatter, 然后仅投影 Agent 业务字段. LF/CRLF、带引号列表与空正文由同一解析入口处理. 顶层必须是 mapping; 名称、显示名、描述和 thinking 必须是字符串, 字符串列表不接受非字符串成员. 布尔和数值字段按各自契约转换, 非有限预算拒绝解析. 重复 YAML key 报错; 单文件失败输出包含路径的诊断并跳过, 其他文件继续加载.

preload_skills 仅接受显式技能名字列表或 false, 无效类型报错, 防止投影成未指定后启用默认隐式技能加载.

迁移决定是采用 Pi 的 YAML 标量语义: 数字或布尔形式的名称加引号, 空列表写为 [], 重复字段合并成一处. 配置位置以 Pi 目录为唯一事实源, 已有安装按 [Settings](../../../../README.md#settings) 手动搬移需要的文件, 不建立双目录读写或自动搬移行为.

文件按文件名排序, 同目录同名定义依此顺序逐字段覆盖, 层间仍为 built-in < global < project. [resolveType](../../../../src/agents/agent-types.ts) 依次执行 exact canonical、唯一 case-fold canonical、唯一 displayName 匹配. 同一层存在多个候选时, 抛出包含排序后 canonical 名称的错误, 不继续按未知名称发现或选择首项.

按需发现保留会话补名契约: 仅在类型未找到时扫描, worktree 只补当前 registry 缺少的 canonical 名称. 已注册定义优先, 新发现项可供本会话后续调用使用. 按 worktree 覆盖同名定义属于另一个产品契约; [已接受策略](../architecture/2026-09-10-isolated-child-resources-and-tool-gates.md) 始终使用接受时副本.

## Alternatives considered

- **维持各自的 HOME 路径与注册顺序选择.** 默认安装代码最少, 但无法表达 Pi override, 同一类型参数还可能执行不同定义.
- **只修 CRLF 并保留手写 parser.** 能保留宽松标量行为, 适合仅修换行的变更; Pi parser 同时正确处理引号列表与空正文, 且已有公开 API. 业务投影负责约束可用字段.
- **歧义时保留首个候选.** 对已有文件最宽容, 但不能给同一输入稳定的含义. exact canonical 仍能明确选择目标.
- **按每个 worktree 建立覆盖 catalogue.** 可以提供完整同名隔离, 但改变当前会话补名契约, 需要独立决定调用级发现和父 registry 的关系.

## Consequences

YAML 的重复 key 和字段类型错误会产生文件诊断. 有意保留的宽松业务形式仍包括逗号列表和布尔字符串. 全局路径选择与 Pi 保持一致; trust gate 只管项目/worktree Agent 定义, 不构成 skills 或工具的安全 sandbox.

## Verification

[parser](../../../../test/unit/agents/agent-discovery.test.ts)、[resolver](../../../../test/unit/agents/agent-types-resolver.test.ts)、[文件扫描](../../../../test/scenarios/agents/agent-file-discovery.test.ts) 和 [worktree 发现](../../../../test/scenarios/agents/agent-types-discovery.test.ts) 检查格式、排序、歧义及补名. [资源与配置](../../../../test/scenarios/config-persistence.test.ts)、[发现入口](../../../../test/scenarios/runtime.test.ts) 和 [skills](../../../../test/unit/prompt/skill-loader.test.ts) 检查 Pi override 与独立 home roots.

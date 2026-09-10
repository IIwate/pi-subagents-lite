# Agent Note: Pi 资源根目录与 Agent 发现歧义修复

Status: proposed

## Problem

[config-io](../../../../src/config/config-io.ts) 和 [events](../../../../src/events.ts) 从 HOME/.pi 拼 global 路径, [runner](../../../../src/agents/agent-runner.ts) 使用 getAgentDir, [skill-loader](../../../../src/prompt/skill-loader.ts) 又使用 homedir. Pi 自定义 agent directory 或 HOME 与宿主 home 不一致时, 设置、定义和子会话资源分裂.

[parseFrontmatter](../../../../src/agents/agent-discovery.ts) 接受 CRLF 开头却只寻找 LF closing delimiter, 标准 CRLF Agent 文件因此没有 name, 在扫描时静默消失. [resolveType](../../../../src/agents/agent-types.ts) 将 case-fold canonical 与 displayName 放在同一个 Map 循环, 较早 alias 可遮蔽较晚 canonical match, 歧义结果随注册顺序变化. 按需 worktree 发现也只补全局缺名项, 不提供同名 worktree 定义隔离.

基准 `4f7aab2` 的生产入口复现: 同一份 name=probe 定义的 LF 文本得到 name=probe, 改成 CRLF 后 name 为 undefined. 按顺序注册 displayName=probe 的 alias-owner 和 canonical=Probe, resolveType("probe") 返回 alias-owner, 而非 canonical 候选 Probe.

## Proposal

推荐分为可单独落地的两步, 均不依赖 [全量模块化](../architecture/2026-09-10-capability-boundaries-and-explicit-runtime.md):

1. 配置、custom prompt 和 global Agent roots 统一复用 Pi 已公开的 getAgentDir/CONFIG_DIR_NAME; 项目/worktree roots 仍经过当前 trust gate. OS home 的 `.agents/skills` 保留其独立约定. 更换位置前明确发布/迁移决定, 不无声双读或移动用户文件.
2. frontmatter 优先评估已安装 Pi 导出的 parseFrontmatter, 以代表性 fixtures 比对当前 flat fields、inline arrays、引号、CRLF 和空正文, 再保留业务字段投影. 名称解析按 exact canonical > 唯一 case-fold canonical > 唯一 displayName; 同层歧义给排序后的候选, 不按 Map 首项猜测. 文件扫描排序使重复定义来源可解释.

worktree 同名定义是否应覆盖父目录是另一产品决定. 最小修复先明确当前补名行为并拒绝歧义; 若要按 worktree 重新解析, 需将发现结果限定本次调用, 不污染父 registry 或已接受快照.

## Alternatives considered

- **只 normalize CRLF, 继续手写 parser.** 能最小修复确定的 Windows bug, 是完整 parser 对照不兼容时的首选缩小范围. 代价是复杂 YAML 仍不支持, 应明确写在契约中.
- **直接整批采用 origin/re catalogue.** `b87698b`, `22d9f3c`, `f5b75fc`, `4b7cb33` 已分别处理格式、资源根、名称和 trust, 但连带 public facade/配置层及行为变化. 推荐提取经过对照的局部逻辑.
- **继续 HOME 路径并自动同步两份资源.** 对旧目录迁移便利, 但制造两个事实源和写入冲突. 路径选择必须唯一且显式.
- **歧义时按注册顺序或随机挑选.** 不增加拒绝, 但相同用户输入可执行不同 Agent 定义. 明确错误比静默选择更可预测.

## Acceptance criteria

- LF/CRLF 内容等价的定义解析结果一致; malformed 单文件不阻断其他有效定义; 名称碰撞不依赖读取顺序.
- 设置 Pi agent directory override 后, config/prompt/global Agent 的读写与 child session 指向同一 root. 用临时目录验证, 保留正常默认路径的有效行为.
- untrusted project 不访问 project/worktree Agent 目录; 同仓库 worktree 校验不代替 trust; 已接受任务不受后续 scan 影响.
- 运行 [discovery](../../../../test/unit/agents/agent-discovery.test.ts)、[resolver](../../../../test/unit/agents/agent-types-resolver.test.ts)、[file scenarios](../../../../test/scenarios/agents/agent-file-discovery.test.ts)、[type scenarios](../../../../test/scenarios/agents/agent-types-discovery.test.ts) 和受影响 config/runner checks.

## Risks

Pi YAML parser 可能将原本字符串解析成数值/布尔或拒绝宽松格式, 需逐项决定兼容含义. 已存在的同名定义可能开始报歧义; canonical root 改变可能让旧配置表面消失, 必须有明确版本/位置决定. 不因路径修复添加未经需求确认的 trust store 或自动授权.

# Agent Note: 配置提交、保存失败反馈与数值校验

Status: implemented

## Problem

配置同时控制后续任务授权、并发和 UI. 磁盘写入失败时, 内存先变会让用户运行一份无法在 reload 后恢复的策略. JSON 数值还可能是 Infinity 或错误类型, 不能直接进入并发和回合比较.

## Decision

[ConfigStore](../../../../src/config/config-store.ts) 为每个 mutation 深拷贝候选配置, 在候选上修改和校验, 保存成功后替换有效配置, 再同步 manager、navigator 或 registry. 保存抛错时有效配置及副作用目标保留旧值. Quick setup 和跨 Provider 的不可用模型规则清理各自只提交一次候选.

```ts type-equiv: ConfigIO from src/config/config-store.ts
import type { SubagentsConfig } from "../../../../src/config/types.js";

export interface ConfigIO {
  load(): SubagentsConfig;
  save(config: SubagentsConfig): void;
}
```

[ConfigIO](../../../../src/config/config-io.ts) 把写入和 rename 错误传给调用者. 同目录临时文件使用随机路径与 wx 独占创建, 只有创建者清理该文件. 部分写入失败仍关闭文件句柄并删除自己的临时文件; 收尾诊断不替换原错误. rename 成功是配置发布边界.

菜单显示失败原因并保留重试入口. SettingsList 的乐观显示值从 Store 恢复; 模型勾选使用候选集合, 保存成功后才发布本地选择. 数值输入和确认操作保存失败时保持打开. [配置所有权](../architecture/2026-09-10-configuration-ownership-and-persistence.md) 继续负责 schema、默认值和副作用归属.

数值规则分别按字段执行:

- 有限 concurrency 按 max(1, ceil(n)) 归一化, 保留小数容量及小于 1 时至少一个 slot 的语义. 加载时非法 default 使用 4, 非法显式 Provider/Model 上限使用 1 并报告字段. 菜单和 mutation 拒绝非有限值.
- graceTurns 使用非负安全整数, 非法加载值使用 6; 菜单拒绝非法输入并保留旧值. 0 的实际后续回合语义由 [回合预算](2026-09-10-assistant-outcomes-retries-and-turn-budgets.md) 定义.
- Agent 文件中的 max_turns/max_tokens 必须是有限数值或可解析的有限数值字符串. maxTurns 未指定或为 0 表示不限; 其他有限值向上取整且至少为 1. 非法声明不能转换成未指定的无限预算.
- 数值菜单解析完整输入, 接受满足最小值的安全整数, 拒绝部分有效字符串和非整数.

## Alternatives considered

- **维持内存优先, 仅补错误提示.** 改动最少, 临时会话可以继续使用新设置, 但需要额外的未保存策略状态. 当前菜单以已保存配置为有效值.
- **修改后失败 rollback.** 能保留原 setter 结构, 但候选状态可能已经被其他读取者观察. 候选提交后发布给出单一可见边界.
- **共享 fragment/revision 配置框架.** 可以合并多个独立 writer 的更新, 但当前单 Store 的失败语义由本地提交边界即可表达.

## Consequences

保存失败拒绝更新是有效策略契约. 路由 JSON schema 沿用 [配置所有权](../architecture/2026-09-10-configuration-ownership-and-persistence.md), 路径使用 [Pi 资源目录](2026-09-10-canonical-agent-resources-and-discovery.md). 独占临时文件避免临时路径竞争, 不提供多进程 lost-update 合并、文件锁或掉电 fsync 保证. malformed 文档仍按当前加载规则回退, 仅显式保存改写目标文件.

## Verification

[Store](../../../../test/unit/config/config-store.test.ts)、[外部 JSON](../../../../test/unit/config/config-io-normalize.test.ts) 和 [真实文件场景](../../../../test/scenarios/config-persistence.test.ts) 检查候选发布、部分写入/rename 失败、原文件保留和 scheduler 上限. [数值与开关](../../../../test/unit/ui/menu/menu-spawn-options.test.ts)、[模型勾选](../../../../test/unit/ui/menu/menu-model-routing.test.ts) 检查失败显示及重试.

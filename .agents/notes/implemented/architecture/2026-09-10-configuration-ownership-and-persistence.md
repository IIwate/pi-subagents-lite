# Agent Note: ConfigStore 所有权、规范化与写入边界

Status: implemented

## Problem

配置既供运行时读取, 又在菜单修改后需要同步 scheduler 和 UI. 分散的全局赋值容易遗漏副作用, 还会与 session override 或旧模型分配字段混淆. 磁盘 JSON 是外部输入, 特别是空模型集合和特殊字典键不能扩大授权.

## Decision

[ConfigStore](../../../../src/config/config-store.ts) 集中持有一份 `SubagentsConfig`, 提供 resolved reads 和具名 mutation. store 在 Shell 构造时建立, session start reload, manager/navigator 创建后通过 setDeps 连接. dispose 只清除依赖引用. 运行时读取和菜单写入共同经过 store; concurrency mutation 持久化后调用 manager, display mutation 同步 navigator, 默认 Agent 策略由相应菜单同步 registry.

[config-io](../../../../src/config/config-io.ts) 读取一个 global JSON 文档, 使用已知 agent keys 和 modelRouting canonical shape. 缺文件、读取失败、JSON malformed 或顶层非对象均回退 defaults. routing 只接受明确的 enabled true, 去除空 provider/重复模型; `models` 缺省的空对象表示 all-model grant, 空/非法数组删除该规则, 不能变成全模型. `Object.hasOwn` 和 defineProperty 保持 `__proto__` 等键为数据, 不授予原型链上的权限.

模型分配时代的 `allowCrossProvider`, `allowedProviders`, `agentModels`, 动态 `agent[type]` 和 `agent.default` 不迁移. 加载只投影当前格式, 下一次显式保存写 canonical shape; 没有后台迁移. provider 暂时不可用时保留休眠授权, 具体策略由 [model access](2026-09-09-model-routing-and-access-policy.md) 负责.

mutation 在候选副本上修改, 同目录独占临时文件写入并 rename 成功后才发布有效配置和副作用. 写入失败保留旧值并向菜单报告. [配置提交](../bug-fix/2026-09-10-configuration-commit-and-validation.md) 负责失败恢复、批量 mutation 和 UI 显示一致性.

systemPromptMode 使用闭集检查, 部分布尔值通过显式比较解析. grace/concurrency 在外部 JSON 和 mutation 入口执行 [字段数值规则](../bug-fix/2026-09-10-configuration-commit-and-validation.md), 非有限值不能进入 scheduler 的容量比较.

## Alternatives considered

- **保留可变配置导出及调用点自行 save/sync.** 文件少、调用直接, 但每个 writer 都需记住持久化及 UI/scheduler 副作用, reload 还会产生陈旧引用. 具名 mutation 收拢这份职责.
- **读时自动迁移任意旧配置.** 升级更平滑, 但旧 assignment 与当前授权不是等价语义, 自动映射可能意外开权限. 当前只接受 canonical routing, 不暗中转换.
- **用 JSON clone/类型断言代替字典入口检查.** 写法短, 但无法区分空名单和全名单, 也无法防止继承键进入授权. 校验留在外部数据入口.
- **全量 generic fragment/revision 配置框架.** 可服务多个独立 capability 和共享文档 writer, 未合入 `origin/re` 的实现有此价值. 当前单 store 的候选提交边界已表达保存失败与发布语义.

## Consequences

store 给调用者统一默认值和副作用入口, 但并非所有 getter 都返回深拷贝: routing 是复制快照, concurrency 的 map 仍共享内部对象, 内部读取者不得修改. malformed 文件会被下次显式保存覆盖; 独占临时文件不提供 fsync 或跨进程更新合并. 路径统一使用 [Pi 资源目录](../bug-fix/2026-09-10-canonical-agent-resources-and-discovery.md).

## Evidence

- `9f412fb`, `c0cb4ef`, `93c287b`, `75ec4b3`, `c600a30`: 配置 mutation/read/副作用集中到 ConfigStore.
- `979f8f3`, `5cc7661`, `aa5e867`: session display override 和旧 widget/assignment 设置的历史取舍; 当前只保留 canonical persisted settings.
- `5b71727`, `aa5e867`, `4b43733`: canonical routing、空数组安全语义及休眠规则.
- `e5443f0`, `ee7414d`, `943bdc1` 的 fragment transaction 和 malformed policy 属于未合入分支证据, 不是本 Note 的实现声明.

## Verification

[ConfigStore tests](../../../../test/unit/config/config-store.test.ts) 验证候选发布、副作用和 routing copy; [config normalization](../../../../test/unit/config/config-io-normalize.test.ts) 验证磁盘形状、数值与特殊键; [真实文件场景](../../../../test/scenarios/config-persistence.test.ts) 验证保存失败和 scheduler 边界; [model access](../../../../test/unit/models/model-access.test.ts) 验证权限不扩大.

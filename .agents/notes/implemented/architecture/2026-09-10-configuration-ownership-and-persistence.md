# Agent Note: ConfigStore 所有权、规范化与写入边界

Status: implemented

## Problem

配置既供运行时读取, 又在菜单修改后需要同步 scheduler 和 UI. 分散的全局赋值容易遗漏副作用, 还会与 session override 或旧模型分配字段混淆. 磁盘 JSON 是外部输入, 特别是空模型集合和特殊字典键不能扩大授权.

## Decision

[ConfigStore](../../../../src/config/config-store.ts) 集中持有一份 `SubagentsConfig`, 提供 resolved reads 和具名 mutation. store 在 Shell 构造时建立, session start reload, manager/navigator 创建后通过 setDeps 连接. dispose 只清除依赖引用. 运行时读取和菜单写入共同经过 store; concurrency mutation 持久化后调用 manager, display mutation 同步 navigator, 默认 Agent 策略由相应菜单同步 registry.

[config-io](../../../../src/config/config-io.ts) 读取一个 global JSON 文档, 使用已知 agent keys 和 modelRouting canonical shape. 缺文件、读取失败、JSON malformed 或顶层非对象均回退 defaults. routing 只接受明确的 enabled true, 去除空 provider/重复模型; `models` 缺省的空对象表示 all-model grant, 空/非法数组删除该规则, 不能变成全模型. `Object.hasOwn` 和 defineProperty 保持 `__proto__` 等键为数据, 不授予原型链上的权限.

模型分配时代的 `allowCrossProvider`, `allowedProviders`, `agentModels`, 动态 `agent[type]` 和 `agent.default` 不迁移. 加载只投影当前格式, 下一次显式保存写 canonical shape; 没有后台迁移. provider 暂时不可用时保留休眠授权, 具体策略由 [model access](2026-09-09-model-routing-and-access-policy.md) 负责.

保存使用同目录 `.tmp` 写入后 rename, 避免通常情况下读到半份目标文件. 当前 mutation 先改变内存, `saveConfigAtomic` 捕获错误并输出 console.error, 返回类型为 void. 因此它不是“持久化成功才发布内存”的事务; 菜单仍可能提示成功, 依赖仍可能收到未保存配置. 也没有 fsync、多进程锁或并发修订号.

当前标量验证并不一致: systemPromptMode 有闭集检查, 部分布尔值通过显式比较解析, grace/concurrency 等字段仍可由 hand-edited JSON 带入异常值. 这是现存缺口, 不是可信内部 API 的保证. [事务保存与输入验证提案](../../proposed/bug-fix/2026-09-10-configuration-commit-and-validation.md) 独立记录改进方向.

## Alternatives considered

- **保留可变配置导出及调用点自行 save/sync.** 文件少、调用直接, 但每个 writer 都需记住持久化及 UI/scheduler 副作用, reload 还会产生陈旧引用. 具名 mutation 收拢这份职责.
- **读时自动迁移任意旧配置.** 升级更平滑, 但旧 assignment 与当前授权不是等价语义, 自动映射可能意外开权限. 当前只接受 canonical routing, 不暗中转换.
- **用 JSON clone/类型断言代替字典入口检查.** 写法短, 但无法区分空名单和全名单, 也无法防止继承键进入授权. 校验留在外部数据入口.
- **全量 generic fragment/revision 配置框架.** 可服务多个独立 capability 和共享文档 writer, 未合入 `origin/re` 的实现有此价值. 当前单 store 不需要先迁入该框架才能修复保存失败; 最小事务方案可独立评审.

## Consequences

store 给调用者统一默认值和副作用入口, 但并非所有 getter 都返回深拷贝: routing 是复制快照, concurrency 的 map 仍共享内部对象. 文件写失败、malformed 文件被下次保存覆盖、多个进程争用 `.tmp` 都是现有边界. 路径由 HOME 推导, Pi 自定义 agent directory 的偏差见 [资源提案](../../proposed/bug-fix/2026-09-10-canonical-agent-resources-and-discovery.md).

## Evidence

- `9f412fb`, `c0cb4ef`, `93c287b`, `75ec4b3`, `c600a30`: 配置 mutation/read/副作用集中到 ConfigStore.
- `979f8f3`, `5cc7661`, `aa5e867`: session display override 和旧 widget/assignment 设置的历史取舍; 当前只保留 canonical persisted settings.
- `5b71727`, `aa5e867`, `4b43733`: canonical routing、空数组安全语义及休眠规则.
- `e5443f0`, `ee7414d`, `943bdc1` 的 fragment transaction 和 malformed policy 属于未合入分支证据, 不是本 Note 的实现声明.

## Verification

[ConfigStore tests](../../../../test/unit/config/config-store.test.ts) 验证 mutation、副作用和 routing copy; [config normalization](../../../../test/unit/config/config-io-normalize.test.ts) 验证磁盘形状与特殊键; [model access](../../../../test/unit/models/model-access.test.ts) 验证权限不扩大. 保存失败和非法标量的拟议契约单独列在 proposed, 不以现有测试通过宣称缺口已消失.

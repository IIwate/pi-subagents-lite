# Agent Note: ConfigStore 所有权、规范化与写入边界

Status: implemented

## Problem

配置既供运行时读取, 又在菜单修改后需要同步 scheduler 和 UI. 分散的全局赋值容易遗漏副作用, 还会与 session override 或旧模型分配字段混淆. 磁盘 JSON 是外部输入, 特别是空模型集合和特殊字典键不能扩大授权.

## Decision

[ConfigStore](../../../../src/config/config-store.ts) 持有所属 ExtensionRuntime 的配置, 提供 resolved reads 和具名 mutation. TaskEngine、Navigator 与 AgentCatalogue 通过 setDeps 注入, 保存后的配额、展示和默认 Agent 开关由 Store 同步. dispose 封闭写入并释放依赖; 迟到菜单回调不能操作另一实例.

[config-io](../../../../src/config/config-io.ts) 使用 getAgentDir 下的 subagents-lite-v3.json. 缺少文件采用默认值, 已存在文件的读取失败、JSON 错误、非对象、未知字段或非法值明确报错. 路由中的空对象表示 all-model grant, 非空 models 数组表示精确授权; 空或非法数组不会被解释为全部模型. 特殊字典键必须是显式 own property.

配置输入仅解释当前格式. 休眠 Provider/Model 授权按原值保留. 一个 mutation 在独立候选上修改, 同目录独占临时文件写入和 rename 成功后才发布配置及副作用, 写失败时保留旧值. 文件入口检查布尔值、prompt/thinking 闭集、正安全整数配额和非负安全整数 grace.

## Alternatives considered

- **保留可变配置导出及调用点自行 save/sync.** 文件少、调用直接, 但每个 writer 都需记住持久化及 UI/scheduler 副作用, reload 还会产生陈旧引用. 具名 mutation 收拢这份职责.
- **读时自动迁移任意旧配置.** 升级更平滑, 但旧 assignment 与当前授权不是等价语义, 自动映射可能意外开权限. 当前只接受 canonical routing, 不暗中转换.
- **用 JSON clone/类型断言代替字典入口检查.** 写法短, 但无法区分空名单和全名单, 也无法防止继承键进入授权. 校验留在外部数据入口.
- **全量 generic fragment/revision 配置框架.** 可服务多个独立 capability 和共享文档 writer, 未合入 `origin/re` 的实现有此价值. 当前单 store 的候选提交边界已表达保存失败与发布语义.

## Consequences

store 给调用者统一默认值和副作用入口, 但并非所有 getter 都返回深拷贝: routing 是复制快照, concurrency 的 map 仍共享内部对象, 内部读取者不得修改. malformed 文件需要修正后才能加载; 独占临时文件不提供 fsync 或跨进程更新合并. 路径统一使用 [Pi 资源目录](../bug-fix/2026-09-10-canonical-agent-resources-and-discovery.md).

## Evidence

- `9f412fb`, `c0cb4ef`, `93c287b`, `75ec4b3`, `c600a30`: 配置 mutation/read/副作用集中到 ConfigStore.
- `979f8f3`, `5cc7661`, `aa5e867`: session display override 和旧 widget/assignment 设置的历史取舍; 当前只保留 canonical persisted settings.
- `5b71727`, `aa5e867`, `4b43733`: canonical routing、空数组安全语义及休眠规则.
- `e5443f0`, `ee7414d`, `943bdc1` 的 fragment transaction 和 malformed policy 属于未合入分支证据, 不是本 Note 的实现声明.

## Verification

[ConfigStore tests](../../../../test/unit/config/config-store.test.ts) 验证候选发布、副作用和 routing copy; [config normalization](../../../../test/unit/config/config-io.test.ts) 验证磁盘形状、数值与特殊键; [真实文件场景](../../../../test/scenarios/config-persistence.test.ts) 验证保存失败和 scheduler 边界; [model access](../../../../test/unit/models/model-access.test.ts) 验证权限不扩大.

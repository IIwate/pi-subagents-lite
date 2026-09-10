# Agent Note: 配置保存失败反馈与有限数值校验

Status: proposed

## Problem

[ConfigStore](../../../../src/config/config-store.ts) 的 mutation 先改内存再调用 save; [saveConfigAtomic](../../../../src/config/config-io.ts) 捕获所有写错误只 console.error, 菜单继续显示成功并同步 manager/navigator. 磁盘权限或 rename 失败时, 用户认为已保存的设置实际只存在内存, reload 后丢失.

外部数值也未完整验证: JSON `1e999` 可解析为 Infinity, `concurrency.models` 的非数值字符串会经 Math.max 变成 NaN. runningCount 与 Infinity/NaN 比较都无法形成预期 ceiling. 非法 graceTurns 同样可破坏硬停止计算. 这些是外部数据入口缺口, 不能因 TypeScript 声明为 number 而忽略.

基准 `4f7aab2` 的生产 ConfigStore 入口可复现: 初始 forceBackground=false, 注入抛写入错误的 ConfigIO, 调用 setForceBackground(true); 调用抛错后 store.agent.forceBackground 仍为 true. 这证明内存先变, 与生产 saveConfigAtomic 吞错是两个可分别修复的层面.

## Proposal

推荐在现有文件内形成最小 commit 边界: 准备候选配置并校验, 保存失败将具体错误返回/抛给菜单, 成功后才替换有效内存并同步副作用. ConfigIO 不吞写失败; 菜单按结果展示成功或失败. 保存失败保留旧 effective value 和原文件, 不需要先拆成 generic fragment framework.

加载与菜单更新对整数/有限数值分别给明确规则. 保持既有可恢复容量语义: 小于 1 的有限 concurrency 归一到 1, 有限小数的有效容量向上取整; 非数值/非有限值不能变成无限并发. grace/maxTurns 的 0、未指定、负数和小数必须按现有合法输入契约逐项决定, 不能只统一套 Math.max. 未知/旧 routing 格式仍按 [当前格式](../../implemented/architecture/2026-09-10-configuration-ownership-and-persistence.md) 处理, 不附带迁移或项目配置层.

现有固定 `.tmp` 在多进程同时保存时可互相覆盖临时文件. 使用独占创建的同目录临时路径可解决临时文件竞争; 对“多个独立 writer 更新同一文档”的 lost update, 需要真实并发编辑需求后再选择冲突拒绝或共享 owner, 不声称换临时文件名就是完整多进程事务.

## Alternatives considered

- **保持内存优先并只补 toast.** 最小行为变化, 但用户仍会运行一份与磁盘不同的有效策略. 若保留这种产品选择, UI 必须显式区分未保存状态; 当前没有这一状态面.
- **先修改再失败 rollback.** 可少改 mutation 写法, 但 side effect 或嵌套读取可能已经观察候选值. 候选提交后发布更清楚.
- **整体采用 origin/re fragment/revision 系统.** `e5443f0`, `ee7414d`, `943bdc1` 有共享 writer 和 malformed policy 的可用经验, 但修当前单 store 不需要先完成该重构.

## Acceptance criteria

- 用真实临时文件模拟 write/rename 失败, 证明原文件、effective value、scheduler/UI 保持旧值, 菜单显示失败; 成功路径只发布一次.
- 有限小数/0 的已有有效行为保留, 非数值及 1e999 不绕过并发或回合上限. tests 使用外部 JSON 入口, 不仅断言内部 helper.
- 检查 [config tests](../../../../test/unit/config/)、[concurrency tests](../../../../test/unit/agents/manager/agent-manager.queue.test.ts) 和受影响菜单; typecheck 通过. 故障测试只操作 harness 临时目录.

## Risks

磁盘失败时从“未保存但运行”改为拒绝更新是明确行为变更, 需获批. 不能把 malformed 文档默认值回退扩展成任意自动修复或静默覆盖. 独占临时文件不提供掉电 fsync 或跨进程更新合并保证.

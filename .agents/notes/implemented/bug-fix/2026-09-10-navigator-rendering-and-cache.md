# Agent Note: 稳定列表组件、缩屏重绘与转录本缓存

Status: implemented

## Problem

动态下方列表与 Pi 自己的 Working/editor/footer 同时改变高度时, differential renderer 可能留下空行或陈旧内容. 每次按键又会要求整个组件 render, 长转录本重复折行会增加输入延迟. 仅依靠完成事件刷新, 重试和人工继续期间的状态又可能不再绘制.

## Decision

[navigator update](../../../../src/ui/agent-navigator.ts) 通过 [PiScreen](../../../../src/ui/pi-screen.ts) 在首次有记录或异常 pending 状态时注册一个稳定的 below-editor widget. 零记录或折叠只返回空 render, 保留组件身份; dispose 才注销. 在拥有该 UI 期间开启 Pi 原生 clearOnShrink, 结束时还原原值. terminal transition 触发 full render, parent agent_end 用下一事件循环的 reflow 等待 Working 行移除, 并保留 hostTui 引用供最后一次布局清理.

展开列表以 Main 为固定摘要行, 子记录窗口容量为 `min(6, max(3, floor(rows / 5)))`, 实际条数再受记录数约束. 3~6 是子记录槽位范围, 不是整个 widget 总高度; command 和 hidden indicators 另占行. 不按 editor/footer 的经验高度减成 0 行. 状态列与统计通过宽度预算降级, 身份与父模型完全相同则省略, 自定义 footer 仍保留. 默认展开设置只决定新 navigator 的初值.

[TaskNavigationSource](../../../../src/ui/task-source.ts) 的列表顺序为 attention(error/aborted/turn_limited)、active(running/waiting/cancelling)、queued、archive(completed/stopped). pin 仅在同一 rank 内提升; terminal 按完成时间倒序, active 按开始时间正序, 完全相等时保留 Map 注册顺序. 这不是 scheduler 队列的重排.

刷新 timer 为一秒. 初次 spawn、统计进展和被接受的人工继续通过 ensureTimer 重启, 当前无选中子屏且无 running/queued/unsettled 时停止. UI 失败由 update/render 边界截住, 停止 timer 并最多提示一次, 后续实际事件仍可重试. 清理依次尝试所有 restoration, 不让一个 host UI 异常阻止其他资源释放.

[声明式展示](../architecture/2026-09-11-declarative-navigation-and-input-actions.md) 把缓存分为消息投影和折行. Native Driver 按不可变 Entry ID 复用投影. TranscriptView 使用只读消息对象、theme 和 width 缓存折行, 不再订阅会话. streaming 单独绘制, 空 thinking 不产生空 Assistant 标题. 列表使用已准备的统计, 不在每秒渲染中扫描 session 历史计算 contextPercent.

## Alternatives considered

- **空列表直接卸载再重建 widget.** 实现自然, 但组件身份变化与 Pi 行缓存叠加会遗留陈旧行. 保留零高度组件让宿主继续管理同一个位置.
- **维护自己的精确高度或 availableRows 估算.** 可以尝试减少全屏重绘, 但 Working/footer/editor 并非由扩展单独控制. 原生 shrink 检测负责整屏变化, 子列表窗口保留固定下限.
- **每次 render 重算全部转录本, 或只按消息数量缓存.** 前者输入代价随长历史增长; 后者漏掉 streaming 原地更新、主题和宽度变化. 按消息身份缓存加事件失效保留这几类行为.
- **只做事件驱动刷新.** 无 timer 成本, 但 duration/retry countdown 仍随时间变化. timer 只在需要时保留, 事件负责重启.

## Consequences

列表不维护第二份 Agent 执行状态机. Source 的只读展示投影由执行事实更新. clearOnShrink/full render 可能清掉终端 scrollback, 这是布局纠错代价, 与持久日志无关. 缓存仍需遍历当前消息并输出行, 不是常量时间渲染. 列表按当前 View 输出与 footer 文本比较是否需要请求绘制, transcript 更新通过所属订阅另外触发重绘.

## Evidence

- `ad49767`, `5cc7661`, `87ddb0f`, `afe0724`, `74a1042`, `b72906d`, `60fbefa`: list-first、单一状态投影、摘要位置和零计数静默.
- `615cb8a`, `dbb4de1`, `8da2e96`: 3~6 槽位、原生 shrink 清理、Working 行结束后的 reflow.
- `34a4f29`, `2ce56bc`, `afc9b34`, `aa69dca`: UI 失败隔离和重试后的刷新恢复.
- `e98e224`, `f80768e`, `4e5ac95`, `911a9df`, `5f7ffb2`, `6d1c997`: transcript cache、空 thinking、排序、默认展开和响应式行布局.
- `1f9356e`, `be978e3`, `26e5639`: 固定状态列、保留可见状态和 provider-first 身份. `b6effc0`, `570fa4e`, `9fa3f2d` 记录定时刷新与旧 LiveView/spinner, 不另建第二份执行状态.

## Verification

[render](../../../../test/unit/ui/navigator/agent-navigator.render.test.ts)、[transcript](../../../../test/unit/ui/navigator/agent-navigator.transcript.test.ts) 和 [lifecycle](../../../../test/unit/ui/navigator/agent-navigator.lifecycle.test.ts) 覆盖布局、缓存与恢复; [source retention](../../../../test/unit/ui/task-source.test.ts) 验证 pin 与展示保留窗口. 旧 output log、tree widget 和重复 footer 的选择依据由 [Stealth](../architecture/2026-09-09-stealth-tool-registration.md) 记录, 不要求恢复已删除实现来测试当前 UI.

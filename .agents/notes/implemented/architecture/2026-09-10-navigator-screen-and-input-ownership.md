# Agent Note: 子屏替换、编辑器委派与焦点所有权

Status: implemented

## Problem

Pi regular/fullscreen renderer 共用 document 和 dock 组件, 直接替换 TUI 根数组会让其中一个 renderer 继续持有旧引用. 同时, 下方列表的高亮候选与真正接收输入的子会话是两个状态. 如果移动高亮就切换输入目标, 或等 Pi 把输入加入 Main 后才拦截, 用户文字可能送到错误会话.

## Decision

[AgentNavigator](../../../../src/ui/agent-navigator.ts) 是消费 NavigationSource 的交互 Controller, 保留 selectedAgentId、highlightedAgentId 和 listFocused 三种状态. [声明式导航与 Action](2026-09-11-declarative-navigation-and-input-actions.md) 定义只读展示和执行动作边界. 空 editor 的 Down 进入列表; Up/Down 只移动候选, Enter 确认切换. 有草稿且目标未变时 Enter 交还 editor 提交, 切换到不同目标时该 Enter 只切换并保留草稿. 普通文字、Unicode 批量输入和 bracketed paste 释放列表焦点后传递给 editor.

[PiScreen](../../../../src/ui/pi-screen.ts) 的 AgentNavigationEditor 包裹宿主已有 editor, 不另建一套输入实现. 它转发 focused、提交、change、autocomplete、图片、Ctrl+D、扩展快捷键和 actionHandlers, 包括 Pi 在包装之后注册的 followUp/dequeue handler. 子屏普通提交在 Main 排队前派发 Steer Action, `app.message.followUp` 使用独立的 FollowUp Action, `app.message.dequeue` 只操作当前子任务. 按键匹配使用宿主提供的键位表并保留 Alt+Up 撤回别名, Alt+T 显式接管. slash 和 `!` 命令仍由 Pi 处理. retry Esc 与子任务 abort 的优先级见 [retry UI](../bug-fix/2026-09-09-subagent-screen-retry-and-steering-visibility.md).

异步交互使用 requestId 与 selectedAgentId 校验回调. 旧回调不能改变新选中会话的提示或草稿; 拒绝只在当前 editor 为空时恢复原输入, 不覆盖用户新写的内容. Ctrl+D 仅清理非活动子记录且需要 Enter 确认; Ctrl+C 取消确认并向上透传, 不切断宿主中断/退出链.

ScreenSwap 只接受经过检查的 Pi 布局: 7 个 root children, document 内 3 个 children, chat 位于 document index 2, editor 和 below-editor selector 的容器关系也必须匹配. 切换仅替换 document 的 chat 槽和 pending/status/footer 的 render 方法, 保留 dock 容器实例, 因而两种 renderer 读取同一组对象. 布局未知或被其他扩展占用时拒绝激活并提示, 不做部分替换.

恢复逐项检查当前引用仍是自己的 replacement, 不覆盖其他扩展后来安装的 chat/render/editor. Footer 每次从当前容器读取, 只裁减 Pi builtin footer 的重复行, 保留自定义 footer. 切屏清 scrollback 并 full render; 这一显示副作用不改变 session messages 或 result inbox. context replacement/dispose 还原 editor、组件和 clearOnShrink 设置; dispose 自身不直接写终端控制序列.

## Alternatives considered

- **高亮即切换, 或仅使用全局 terminal input listener.** 状态少、拦截早, 但会干扰 overlay/autocomplete 的焦点, 也无法表达“浏览候选但仍对原会话输入”. 包装被聚焦的 editor 保留宿主输入路径.
- **直接换 root children 或同时支持多代私有布局.** Pi 0.83 的布局上可用, 但 0.84 fullscreen 保留容器引用, 简单换根数组失效. 多套私有布局扩大故障面; 当前仅接受已经检查的结构.
- **无条件恢复旧组件.** 清理容易, 但会覆盖另一扩展在此期间获得的 UI 所有权. 引用相等检查是共存约束, 不是可随意删除的防御噪声.
- **独立子屏输入框和 footer.** 隔离直接, 但复制 Pi 编辑、图片、快捷键和第三方 footer 集成. 当前选择委派和可恢复的替换.

## Consequences

导航状态不受用户在 regular/fullscreen 间切换影响, 但实现明确耦合 Pi 私有布局. 升级 Pi 应复核所有权冲突、容器关系和两种 renderer. 这些检查针对动态 host 结构, 不等同于在已校验的内部 TypeScript 值上重复防御. 列表刷新、缓存与终端文本分别由 [rendering](../bug-fix/2026-09-10-navigator-rendering-and-cache.md) 和 [terminal controls](../bug-fix/2026-09-10-terminal-control-sanitization.md) 负责.

## Evidence

- `36d300f`, `ad49767`, `c4f3898`, `615cb8a`: 交互子屏、确认式列表导航和中断透传.
- `65d1690`, `74a1042`: Pi document/dock 布局及自定义 footer 保留.
- `afe0724`, `fb2affa`, `e148212`: 局部交互拒绝、子会话 Esc、Enter 与 paste 焦点处理.

## Verification

[navigator input](../../../../test/unit/ui/navigator/agent-navigator.input.test.ts)、[interaction](../../../../test/unit/ui/navigator/agent-navigator.interaction.test.ts) 和 [lifecycle](../../../../test/unit/ui/navigator/agent-navigator.lifecycle.test.ts) 验证输入目标、草稿、迟到回复、容器替换与恢复. Mock TUI 证明组件契约, 不替代 physical terminal 的焦点/IME 联调.

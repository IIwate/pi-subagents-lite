# Agent Note: 终端控制字符与光标标记的输出边界

Status: implemented

## Problem

工具和模型文本可能含 BEL、OSC、CSI 或其他控制字符. 后台静默时这些字节没有输出, 切入子屏渲染 transcript 才写入终端, 因而提示音看起来发生在“切换”而非内容产生时. Windows Terminal 的 audible bell 开启时, WSL 中输出的 BEL 会由宿主终端响应. 多个 editor/list 光标标记也会进入同一帧.

## Decision

[displayText](../../../../src/ui/format.ts) 先用 Node `stripVTControlCharacters` 去除可识别的终端序列, 再规范化 CRLF/CR 为 LF, 清除 C0/C1(保留 tab 和 LF). 源文本在加 UI 自己的 ANSI 样式、折行或截断前清洗. 只去 BEL 不足以覆盖 OSC 标题/链接/其他终端控制, 在最终整帧清洗又会删掉应用自己的颜色和光标控制.

当前 navigator 的 user/assistant/thinking/toolResult/bashExecution/summary、错误、描述和模型身份使用这一显示转换. [selector 与 queued steering](2026-09-10-terminal-preview-and-queue-sanitization.md) 的独立显示入口同样清洗来源文本. 单行字段另将换行展平. 原始 session 和父 inbox 内容不改写, 清洗不是数据持久化或交付内容的规范化规则. Tool argument summary 多数通过 JSON.stringify 转义字符串后展示.

AgentNavigationEditor 在列表聚焦时从 base editor 渲染行移除全部 Pi CURSOR_MARKER. 这是宿主私有 APC 光标协议, 不应当作普通内容打印. 真实 editor 聚焦时保留标记, 由 Pi 定位输入法/终端光标. [焦点处理](../architecture/2026-09-10-navigator-screen-and-input-ownership.md) 仍保留 Ctrl+C 和其他宿主输入能力.

`ESC[3J` 的含义是清 scrollback, 本身不是 BEL. 切屏和 shrink redraw 会增加内容重放机会, 但仅凭发生时机不能证明清屏序列或方向键就是声音来源. 源码测试证明特定输入经过已覆盖 renderer 后不含危险字节, 不证明所有终端或上游 editor 永不响铃.

## Alternatives considered

- **保留原始 ANSI 以显示工具自带颜色.** 颜色保真最好, 但将不受信任的 terminal commands 一并回放. 当前允许 UI 自己决定样式.
- **在 Windows Terminal 关闭 bell, 或只删 `\x07`.** 用户设置可绕开声音, 单字符过滤也易实现, 但两者都没有覆盖 OSC/CSI 等输出控制, 且前者不能作为扩展跨终端的修复.
- **删除 full render/scrollback 清理.** 可能减少声音触发次数, 却丢掉 [布局修复](2026-09-10-navigator-rendering-and-cache.md), 并不阻止下一次输出同样内容.
- **所有非导航键都被列表吞掉.** 减少底层 editor 空操作, 但损害草稿、paste 和退出快捷键. 当前只消费明确的导航操作.

## Consequences

显示清洗保留正常 Unicode 文字, 代价是源 ANSI 颜色和控制语义不保留. 该防线仅对实际调用 displayText 的路径生效; 新 renderer 必须在加样式前转换来源文本. 自动验证覆盖指定输出入口, 不承诺宿主其他组件永不响铃.

## Evidence

`51499d4` 同时记录源文本控制字符清洗和列表焦点下 CURSOR_MARKER 去除. `65d1690` 确立当前 Pi TUI 布局; `dbb4de1` 记录仍需保留的 shrink 清理, 两者解决的不是同一个问题.

## Verification

[format tests](../../../../test/unit/ui/format.test.ts) 和 [navigator transcript](../../../../test/unit/ui/navigator/agent-navigator.transcript.test.ts) 检查源控制字符; [navigator render/input](../../../../test/unit/ui/navigator/agent-navigator.render.test.ts) 检查列表与 editor 输出. 离线测试不播放 BEL, 不代表对 Windows Terminal audible bell 做了物理复验.

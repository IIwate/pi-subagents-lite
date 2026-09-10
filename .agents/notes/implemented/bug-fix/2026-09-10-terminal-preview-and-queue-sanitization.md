# Agent Note: 选择器预览与排队输入的终端显示边界

Status: implemented

## Problem

预览、摘要和 queued steering 是独立的终端输出入口, transcript 的清洗不会自动覆盖它们. 强制 selector 至少 50 列还会越过宿主提供的宽度, 引起自动折行和 modal 行数不一致.

## Decision

[DeliverySelectorComponent](../../../../src/ui/delivery-selector.ts) 在构建显示项时使用 [displayText](2026-09-10-terminal-control-sanitization.md) 清洗消息正文和摘要; 标题的 Agent type 也先清洗并展平换行. 来源文本的转换先于 Markdown、UI ANSI 和宽度截断. [navigator](../../../../src/ui/agent-navigator.ts) 的 child pending 与 transcript fallback 均清洗并展平 queued steering 文本.

显示项是独立数据, session、交付快照与待 Alt+Up 重新编辑的队列保留原始文本. UI 自有 ANSI 和 [CURSOR_MARKER 焦点](../architecture/2026-09-10-navigator-screen-and-input-ownership.md) 继续由各自 renderer 管理.

selector 以宿主 width 为上限. 50 列及以上使用双列, 20 至 49 列显示当前消息选择状态、序号和单列预览; 更窄时显示简短退出提示. footer 在宽度不足时使用紧凑操作提示, 保留 Esc. 同一终端尺寸下 body 行数固定, 预览按该高度裁剪或补齐; 保存错误占用既有 body 行. 这些尺寸不参与下方导航列表的行数契约.

## Alternatives considered

- **维持仅 transcript 清洗.** 不改变其他 renderer, 但 preview/queue 的源文本仍可把 BEL、OSC 或 CSI 带到终端.
- **整帧统一删除 ANSI.** 覆盖入口广, 但会删除 UI 的样式和光标协议. 源文本与应用控制必须分开.
- **始终维持至少 50 列.** 排版简单, 但把终端宽度当作建议, 自动折行后高度无法保持. 窄窗布局直接服从实际宽度.

## Consequences

源 ANSI 样式被移除, 普通 Markdown 仍由宿主 renderer 处理. 小窗口每次预览一条消息, 上下键保留浏览与选择能力. 离线字节和可见宽度断言不等同物理终端的响铃或字体测试.

## Verification

[selector](../../../../test/unit/ui/delivery-selector.test.ts) 检查 BEL/OSC/CSI/CRLF、UI ANSI、20/30/50/80 列可见宽度与稳定行数. [navigator transcript](../../../../test/unit/ui/navigator/agent-navigator.transcript.test.ts) 检查队列显示, [interaction](../../../../test/unit/ui/navigator/agent-navigator.interaction.test.ts) 检查原始队列文字返回 editor. 自动验证只检查字符串, 不播放控制字符.

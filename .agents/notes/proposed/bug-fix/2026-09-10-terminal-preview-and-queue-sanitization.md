# Agent Note: 选择器预览与排队输入的终端文本防线

Status: proposed

## Problem

[DeliverySelectorComponent](../../../../src/ui/delivery-selector.ts) 将消息 summary/content 和 record type 直接传给 truncate/Markdown/theme. [navigator](../../../../src/ui/agent-navigator.ts) 的 renderChildPending 与 transcript fallback 也直接插入 queued steering text. 这些文本没有经过 [displayText 防线](../../implemented/bug-fix/2026-09-10-terminal-control-sanitization.md), 可把粘贴或模型输出中的 BEL/OSC 重新带到终端. 已有 transcript 清洗不能保护这些独立入口.

另一个可直接确认的 geometry 问题是 selector 的 render(30) 强制 totalWidth 至少 50; 现有窄窗测试只断言返回字符串, 没证明可见宽度不越界. 小终端上可能发生自动折行与 modal 行数不一致.

在 `4f7aab2` 的生产 DeliverySelectorComponent 中, 对含 BEL 的 assistant 文本调用 render(30), 返回行的最大 visibleWidth 为 50, 且仍含原始 BEL. 该检查仅检查返回字符串, 不向物理终端输出控制字符.

## Proposal

推荐在现有 renderer 中复用 displayText, 在加入 UI ANSI/Markdown 样式和截断前清洗源内容, 单行 title/summary/queued 行再展平换行. 保留原始 payload 供交付和 Alt+Up 编辑, 不用 sanitize 覆盖 session/queue 数据.

selector 以宿主传入 width 为上限, 窄于双列所需宽度时使用单列预览或简短可操作状态, 保留 Esc. 内容切换保持同一终端尺寸下的 body 高度; 不把高度估算重新引入下方 3~6 行导航契约. 这两点可在 selector/navigator 内独立实施.

## Alternatives considered

- **关闭宿主 bell 或只处理 transcript.** 改动少, 但忽略其他 terminal control, 且 preview/queue 是不同的输出路径.
- **最终输出整帧统一 strip ANSI.** 覆盖范围广, 但连 UI 的颜色/光标协议也删除. 应只净化来源文本.
- **永远强制宽度至少 50.** 双列排版容易, 但传入宽度是终端约束而非建议. 可以对小宽度降级, 不能靠无异常字符串返回宣称适配.

## Acceptance criteria

- 含 BEL、OSC、CSI、CRLF 的消息进入 selector/queued display 后无源控制序列, 原 session 和待重新编辑文本仍逐字保留.
- 不清掉 UI 自有 ANSI; 保留 [CURSOR_MARKER 焦点](../../implemented/architecture/2026-09-10-navigator-screen-and-input-ownership.md) 行为.
- 20/30/50/80 列下每行 visibleWidth 不超过 width, 短长预览切换不改变 body 行数, 空列表仍可 Esc.
- 用 [selector tests](../../../../test/unit/ui/delivery-selector.test.ts) 和 [navigator transcript/input](../../../../test/unit/ui/navigator/) 检查输出字节与宽度. 物理终端响铃仅作为可选联调, 不向用户终端输出 BEL 作自动测试.

## Risks

预览会失去源 ANSI 样式, 但可保留正常 Markdown 渲染. 极窄宽度下必须优先保留可读状态与退出, 不在前端展示实现细节. 宿主 Markdown 产生的合法 ANSI 与原输入控制字符应明确分开.

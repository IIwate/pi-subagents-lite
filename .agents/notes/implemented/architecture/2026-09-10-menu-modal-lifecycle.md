# Agent Note: 设置菜单的单一模态与输入委派

Status: implemented

## Problem

一个 `ctx.ui.custom` 内再次打开另一个 custom modal 会破坏 Pi 的当前组件和返回链. 反复销毁重建设置列表又会丢失光标位置. 同一组件既承载列表快捷键又承载搜索/数字输入时, 无条件把 j/k 或左右键转换成导航会阻止正常输入.

## Decision

[showAgentsMenu](../../../../src/ui/menu/menus.ts) 的顶层 dispatcher 先关闭当前 SelectList, 再 await 选中的子菜单, 返回后重新构建主列表. 设置叶页复用 SettingsList 的内部 cursor/submenu, 需要选择器切数字输入时用 [delegating component](../../../../src/ui/menu/helpers.ts) 换内部 active component, 不嵌套新的 custom modal.

[SettingsListWrapper](../../../../src/ui/menu/wrappers/settings-list.ts) 仅在非 focusable 子菜单时把 j/k、左右键解释为列表动作. focusable Input/Search 子菜单接收原始键和 focused 状态, 保留文字、光标和 IME. 分隔/锁定行跳过保持移动方向和环绕, 全部不可选时有界搜索, 不无限循环. rebuild 同时更新 items/filteredItems/cursor, 是否保留 submenu 由明确参数决定.

可搜索 provider/model/type 列表复用 Pi Input、fuzzyFilter 和 keybindings. 值与显示 label 分离, provider badge 只补 label 尚未表达的信息; 空过滤集合的导航不越界. 当前 system prompt 页因 custom 模式改变可用项而重建. Model routing 的 Parent 行、dormant 保存项和清理流程属于 [授权语义](2026-09-09-model-routing-and-access-policy.md), 菜单只组织它们.

## Alternatives considered

- **连续嵌套 ctx.ui.custom.** 调用点直观, 但宿主只有一个当前自定义交互, 返回可落到已被替换的父 modal. 单个 modal 内委派或先关闭再打开保持明确的所有权.
- **每次设置变化重新调用 ui.select.** 不需要维护 list 对象, 但光标回到开头, 用户连续修改体验不稳定. 持续的 SettingsList 适合叶页, 顶层选择后离开则可重建.
- **所有层统一转义 j/k/左右键.** 快捷键统一, 但会破坏搜索词和 Input 光标. focusable 子组件是文本输入的边界.
- **菜单派发新 Agent 并自带结果 viewer.** 全部工作集中在 `/agents` 很直接, 但与 [标准 editor/selector](../feature/2026-09-10-human-takeover-and-selective-delivery.md) 形成两套输入和结果路径. 当前菜单负责配置, 执行通过 Agent 工具或子会话 editor.

## Consequences

菜单借用 Pi 现有输入组件, 但 wrapper 仍依赖 selectedIndex、submenuComponent、filteredItems 等私有字段; Pi 升级需验证委派和 rebuild. 内部 hint 文本识别与 focusable 判定也不是稳定的公共 modal-stack API. Pi 组件依赖位于 UI 层, 配置通过所属 Runtime 的 ConfigStore 提交; 所有权划分见 [v3 能力边界](2026-09-10-capability-boundaries-and-explicit-runtime.md).

## Evidence

- `2f5f318`, `daf7498`, `cd2d457`, `33393ce`, `593a50f`: 手动派发与设置页的历史分工、SettingsList 和顶层选择的取舍.
- `e6ffd01`, `ef75483`, `f0340bd`, `c6c0be1`, `d12cd97`, `bc3ac9e`: 嵌套 modal 故障、组件委派与焦点传递.
- `55c09df`, `6dd7998`, `0651a60`, `20fda45`: 动态重建、方向跳过和 description/hint 表面.
- `5275203`, `9d1d0d6`, `faaff6c`, `60ffe42`, `03849d7`, `e8ed6ae`, `47af23d`: 搜索选择、独立 running menu 裁撤及顶层扁平导航.

## Verification

[menu dispatcher](../../../../test/unit/ui/menu/menus.test.ts)、[wrapper](../../../../test/unit/ui/menu/wrappers/settings-list.test.ts)、[helpers](../../../../test/unit/ui/menu/helpers.test.ts)、[system prompt](../../../../test/unit/ui/menu/menu-system-prompt.test.ts) 和 [submenus](../../../../test/unit/ui/menu/submenus/) 覆盖 modal 关闭次序、输入委派和 rebuild. 类型数、行号或提示全文不作为菜单正确性的替代断言.

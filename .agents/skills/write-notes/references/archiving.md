# 按需阅读: 归档与决策替代

归档用于已经被取代或只需保留为历史依据的决定. 当前仍指导实现的决定留在 implemented 并就地维护. 新需求改变前提时可以重新判断, 不以记录年龄、长度或“已经稳定”决定是否归档.

## 预览与执行

先完成新决定的内容, 再预览旧 Note 的归档:

```bash
npm run note-refs -- .agents/notes/implemented/architecture/2026-09-12-old.md
npm run archive-note -- .agents/notes/implemented/architecture/2026-09-12-old.md --replacement .agents/notes/implemented/architecture/2026-09-12-new.md --dry-run
```

预览列出归档目标、需要修改的引用、替代 Note 和 manifest 路径, 不写入文件或创建目录. 同名文件的其他引用以及已经指向归档路径的链接不列为待修复项. 检查内容后去掉 --dry-run 执行即可; 预览不是额外用户审批.

没有后继决定的历史归档可以省略 --replacement. proposed 中的未采纳提案使用 rejected 或删除, 不交给归档命令.

## 工具行为

1. 检查源文件、归档目标与可选的 implemented 替代 Note. 目标已存在时拒绝覆盖.
2. 读取并验证已有 manifest 及其登记文件. 损坏的 JSON、非法路径、缺失文件或哈希不符会在修改前报错, 不重建空 manifest.
3. 按归档后的目录重写旧 Note 的相对链接, 保留其原来指向的文件和片段. 代码围栏内的示例保持原文.
4. 添加 Archived 日期. 指定替代 Note 时, 旧记录获得 Superseded-by 链接, 新记录获得 Supersedes 链接, 两者按最终位置生成.
5. 将其他 Markdown 中指向旧位置的链接改为归档位置, 保留引用历史决定的含义. 源码中的 Note 路径在指定 --replacement 时改指新决定, 否则改指归档记录. 当前行为说明是否也应引用新决定, 仍需根据文字含义维护.
6. 写入归档、受影响文件和 SHA-256 manifest, 最后移除源位置. 完成后运行 npm run verify-notes.

归档前的链接整理属于移动操作; 完成归档的正文保持冻结. 无需提前手写一条移动后会失效的同目录替代链接. 工具支持 Markdown 内联链接、引用定义、角括号目标和片段, 不作为完整 Markdown parser 使用.

## 写入与失败边界

现有文件通过临时文件替换, 源 Note 在其余写入成功前保留. 可捕获的写入失败会尝试恢复已修改文件并报告原因; 恢复失败单独报告.

这不是跨文件原子事务. 进程被强制终止、存储设备故障或并发编辑可能留下未完成操作. 同一仓库的归档顺序执行, 中断后根据原文件、差异和预览检查状态, 不自动删除可能属于其他操作的文件.

## 归档验证

```bash
npm run verify-archives
```

archive-note 总会登记归档文件的 SHA-256. verify-archives 检查 manifest 格式、登记路径、文件存在性和内容哈希; 它是新脚手架 verify-notes 的一部分. 没有 manifest 或未登记的历史文件不具有哈希校验保证, 工具不会擅自为旧文件重新建立基线.

归档正文中的历史链接、格式和旧类型不参与当前 tree、format、文档编译或 AST 契约检查. 内容封印只验证字节一致, 不证明历史结论正确.

旧项目通过 write-notes update --scripts 更新工具和门禁命令. 普通 update 保留项目已有脚本及命令.

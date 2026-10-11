# 知识库收件箱入口

公开操作位于 `/api/inbox/`，全部使用 POST、JSON 和现有 `X-Organizer-Token` 会话校验。`id` 为已保存且校验通过的知识库身份；客户端不必传递批次。

| 操作 | 输入 | 行为 |
| --- | --- | --- |
| `scan` | `id` | 执行一次来源扫描，不调用模型，也不自动选择材料 |
| `list` | `id` | 读取文件整理项、独立阶段、建议、审核与归档状态，不扫描或启动分析 |
| `start` | `id, itemIds` | 仅处理明确选择的文件；重复启动保留有效结果，重启后手动继续 |
| `review` | `id, itemId, name, category, manuallyEdited` | 沿用命名、分类和来源校验保存完整审核，尚不移动文件 |
| `archive` | `id, itemIds, requestId, approved: true, writersPaused: true` | 归档明确确认的新增材料，保留原有外部写入、目标占用和归档日志保护 |

返回 `{libraryId, revision, items}`。每项的 `itemId` 独立于当前路径，持久化记录关联知识库、源文件身份、内容哈希和内部执行证据。文件系统身份以 bigint 的设备、inode 和创建时间保存；改名保持文件整理项身份，复用未变化正文分析，但清除旧分类及执行授权。正文变化清除当前建议并保留历史引用。分页批次读取核对同一 revision，无法获得一致快照时返回可重试的 `INBOX_BUSY`。

基础状态为 `pending`、`waiting`、`analyzing`、`paused`、`reviewable`、`needs-classification`、`needs-information`、`failed`、`confirmed`、`archived`、`missing`。分类返回空结果不算可审核。归档完成按执行器成功结果更新；不因已保存审核而显示成功。

界面从所属知识库直接刷新、勾选、处理和审核文件；首次重构保留原流程，历史记录与恢复放在独立展开入口。人工草稿与选择保存在独立页面状态，刷新建议不覆盖尚未保存的输入；分类待定须明确选择目标，Raw 根目录使用合法的空字符串分类。

本基础切片在当前知识库分析完成后归档；运行中追加、自动暂停归档、分类提议、规则及旧结果接入由后续任务扩展。历史材料的归档仍要求原有副本验证和原库执行链路，不通过新增材料入口绕过保护。

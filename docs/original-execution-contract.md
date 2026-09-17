# 已验证方案应用原库

`createOriginalExecutionService({ verify, checkpoint })` 提供 `prepare`、`execute`、`get`；兼容别名为 `prepareOriginalExecution` 和 `executeOriginal`。页面 `/original` 经本地会话保护调用 `/api/original/prepare|execute|get`。默认使用固定上游 Rust 重扫器，网页不能提供验证器、模型或任意执行根。

## 审核与冻结

`prepare({ planManifestPath, validationJournalPath, recoveryReportPath, writersPaused:true })` 从磁盘核验三份同批证据，返回独占创建、位于原库外的 `authorizationPlanPath`。页面展示原库、备份、验证副本、恢复演练目录、选中和排除项目及证据位置。所有路径接受绝对路径，Windows 短路径输入先解析实际位置。

验证日志必须为 `verified-copy` 的 complete 或 partial，冻结逻辑计划中的每个 selected 项均为 succeeded；非选中项的状态与范围须完全相同，不能扩大排除项、跳过失败项或用恢复成功代替迁移成功。前后重扫无变更任务或变更事件，无生成、视觉或嵌入模型尝试；存在索引时，还要求全部表的向量保留证据。

恢复演练必须为 `new-directory`，完整磁盘报告及恢复计划哈希一致，并绑定同一计划、备份、批次和成功验证日志的文件哈希。恢复目录须仍等于演练完成基线，验证副本须仍等于成功迁移的 afterBaseline。原位恢复使副本回到旧内容，因此不能作为此处放行证据。

原库须仍匹配完整备份基线及目录清单，包含隐藏文件和空目录。原库与验证副本分别保留备份记录中的身份。最后审核计划指针仍须有效。任何变化都要求重新检查、备份、验证，不能靠重新点击执行绕过。

## 执行和恢复

`execute({ authorizationPlanPath, approved:true, writersPaused:true })` 在执行前再次核验全部证据及原库基线。根据冻结 request 在原库确定性编译物理改动，已知绝对缓存位置与项目身份归一化后，逻辑计划哈希必须与验证副本完全相同。只复用链接、缓存、目录和索引规则，不调用内容规划模型。

执行复用 `executeCompiledMigration`，原项目 UUID 保留，绝对缓存地址指向原库。该内部引擎接受受信服务构造的上下文；不作为 HTTP 任意根入口。备份从不作为执行目标。执行前后真实重扫，维护 Raw SHA256、MD5 快照、链接与 sources，迁移已有索引标识并逐值保留向量，重连搜索验证目标。

返回 `resultPath`、`journalPath`、`status`、`items`、`targetRole:'original'`、实际三份库位置及恢复入口。结果和逐步日志位于原库外，独占创建防止重放。`get({ resultPath })` 可在新进程查询；执行进程中断时读取最新日志阶段，不重试文件写入、不公开正文原像。

原库日志使用 `targetRole:'original'`、备份确定的 `targetRoot`，继续绑定原验证 manifest 的 `planManifestHash`、`logicalPlanHash` 和 `backupManifestHash`，可直接交给 T7 `createRecoveryService`。失败保留原库现场和中转文件；恢复前先保留新增数据。原位恢复保留原 UUID，独立恢复获得新身份。

## 验证

`test/original-execution.test.js` 覆盖公开 HTTP 审核与执行、partial 安全子集、原 UUID/绝对缓存/Raw 反链、共享来源、真实 v1/v2 索引和检索、完整原库基线变化拒绝、证据损坏、未完成验证、模型尝试、写入后真实进程退出和 T7 保留现场恢复。全部使用合成原库。

设置 `ORGANIZER_RESCAN_BINARY`，WSL 再设置 `ORGANIZER_RESCAN_WSL_DISTRIBUTION`，联合用例使用真实 Rust 对验证副本、恢复演练及原库执行前后扫描。2026-09-17 已完成真实 WSL 验证和浏览器审核执行：选中 1 项成功、排除 1 项未执行、2 张真实索引、0 模型尝试、0 重扫变更。保留浏览器证据为本机临时目录 `organizer-combined-gaSJFC/library.authorization-fec4af01-f743-4370-be63-a74cd0d800a2.json.result.json`。

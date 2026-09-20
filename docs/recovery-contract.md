# 完整备份恢复（T7）

入口 `/recovery`。暂停全部写入后，提供迁移 `journalPath` 查看现场，再选择全新独立目录或原位置恢复。界面展示将保留的新增、修改和缺失文件；原位置恢复先将整个现场换位到独立目录，绝不直接覆盖现场。完整备份只读，不在备份目录运行重扫或 Wiki。

`POST /api/recovery/inspect|plan|execute|get` 均沿用本机会话令牌。`plan` 输入 `journalPath, mode, destination?, scenePath?, writersPaused`；返回 `recoveryPlanPath`。审核后 `execute` 输入 `recoveryPlanPath, approved:true, writersPaused:true`。重启后 `get` 或 `execute` 仍只需要磁盘计划路径。

恢复独立读取迁移清单、日志及备份报告，核对清单哈希、逻辑计划哈希、备份报告哈希、目标角色和备份全量内容。失败现场无需符合迁移前基线；它按当前完整清单另外冻结并保留。恢复不按迁移 `completed` 逆推数据，而从完整备份重新构造工作目录。

## 持久证据与续作

计划保存在 `${targetRoot}.recovery-${recoveryId}.json`，结果为同名 `.result.json`。计划包含 `sourceJournalPath/sourceJournalHash`、`planManifestPath/planManifestHash`、`logicalPlanHash`、`backupReportPath/backupManifestHash`、`batchId`、`targetRole/targetRoot`、`beforeBaseline/beforeDirectories`、`scenePath/destination/stagingPath` 和审核后的身份。`recoveryPlanHash` 与 `reportHash` 都是删除自身哈希字段后对 `JSON.stringify(record)` 的 SHA-256；读取前验证。

每步先持久化 `phase` 再操作，完成后持久化 `completed`。复制允许重用严格匹配的文件子集；换位通过源、现场、暂存位置与完整哈希辨别已完成操作。冲突停止且保留全部目录。测试实际子进程在 `park` 完成但完成记录未写入时退出，再由新服务续作成功。结构化身份绑定在任何写入前持久化 project、cache、ingest queue、change queue 以及已适配聊天／文件历史／审核记录的精确前态与目标后态。续作先核对文件集合没有增删、文件不共享硬链接，再核对所有文件各自只处于这两个状态之一，再补全未写入后态；未知用户修改报 `RECOVERY_BIND_CONFLICT`，全部现场和完整备份保持原样。无后态证据的旧中断日志保守停止，不盲目恢复前像。HTTP 报告剔除绑定字节，磁盘完整报告保留审计证据。测试通过真实子进程在 final-bind 写后退出，再经 HTTP 续作，覆盖无修改成功及 project/cache 用户修改保留。

成功结果包含 `restoreRoot/projectId`、`afterBaseline`、`verification.sources/links/indexes/proof`、`modelAttempts` 和 `backupUnchanged`。验证核对所有来源缓存 SHA-256、产出位置、Wiki 来源身份、链接与真实 LanceDB v1/v2 全行浮点位模式，并重连进行向量搜索。真实 Rust 重扫要求零任务、零模型尝试；扫描后恢复 snapshot/queue 原字节，避免改变证据基线。

## 后续原库执行的界限

恢复本身接受 complete、partial 或 failed 的可信迁移日志，因为这些现场均可能需要恢复。恢复成功不代表迁移成功。T8 应重新读磁盘，确认恢复报告对应同一个成功验证 journal：partial 仅当所选项全部 succeeded、且没有 failed/applied-unverified/not-run 时可作为安全子集。排除项不可被恢复报告扩大到执行范围。

优先用 `new-directory` 演练，使迁移后验证副本继续保持成功 journal 的 `afterBaseline`。`same-location` 已回到迁移前内容，不能继续把它当作迁移成功副本。原库失败恢复支持 `targetRole:original`，保留备份记录的原项目身份；独立恢复使用全新身份。

## 真实验证与边界

`test/recovery.test.js` 包含新目录/原位/原库身份、磁盘证据损坏、现场变化、损坏备份、模型尝试、真实子进程退出和 HTTP 联合恢复。设置 `ORGANIZER_RESCAN_BINARY`（WSL 可加 `ORGANIZER_RESCAN_WSL_DISTRIBUTION`）使恢复及索引联合用例执行固定上游 Rust 扫描。

外部前端工具可将 `UPSTREAM_VALIDATION_MANIFEST` 指向成功恢复磁盘报告，仅允许 `new-directory + targetRole:validation` 的独立恢复目录，验证全量恢复及备份基线、身份与证据链。它执行固定上游 TS 入口和真实 Rust 扫描，模型及摄取出口记录并阻断。报告的 `stateHashes` 明确证明快照/队列恢复原字节。这覆盖实际扫描与事件消费者，不声称覆盖完整桌面进程、系统 watcher 或真实模型网络服务。

已保留本地合成证据：`C:/Users/32582/AppData/Local/Temp/organizer-migration-J711Hb/recovery-frontend-proof.json`，真实 v1/v2 索引共享库恢复后 changedTasks、attempts、frontendSideEffects 为空，两份状态文件前后 SHA-256 相同。该路径是本次执行产物，不是项目运行依赖。

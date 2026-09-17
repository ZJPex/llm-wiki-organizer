# 完整备份与验证副本接口

`src/backup.js` 提供 `createBackup(input)`，输入为 `{ libraryPath, wikiSourcePath, backupPath, validationPath, writersPaused }`。仅支持所有外部写入已停止的离线目录；程序再次执行预检、检查待处理任务与数据库日志／锁、复制并核验前后基线。用户确认和重复哈希扫描都不是操作系统排他锁，无法阻止未遵守暂停要求的第三方程序。本阶段不允许启动原库迁移。

浏览器从预检结果链接进入 `/backup`，通过同源会话令牌调用 `POST /api/backup`。目标父目录必须已存在，恢复备份和验证副本必须尚不存在。知识库与所有目标祖先的目录连接、符号链接及库内共享硬链接均拒绝；普通字节复制产生独立文件，不使用硬链接。完整复制包括空目录、隐藏状态、配置、历史、附件和索引。

返回报告包含独立生成的 `batchId`、三目录绝对位置、源码版本证据、`baseline`（原库及恢复备份共用）、`directories`、`validationBaseline`、备份与副本校验状态、阶段和结构化错误。`status:complete` 仅代表离线复制和结构化重定位校验完成，`migrationAllowed` 始终为 `false`。

报告以 `${backupPath}.organizer-report.json` 保存于备份外，同名文件不会覆盖。失败后保留现场和报告，不自动清理。恢复备份根目录是原库逐字节副本，不加入 Organizer 元数据。`verifyBackup(backupPath, expectedBaseline, expectedDirectories?)` 可用于后续执行／恢复前重新核验；不要仅信任历史报告中的通过字段。

验证副本从已核验恢复备份再次复制。0.6.11 的 `.llm-wiki/project.json` 由 `src/lib/project-identity.ts` 核验为 `{id,createdAt}`，副本获得新 UUID；已知摄取／文件变更队列的 `projectId` 同步改为副本 UUID，缓存 `filesWritten` 的原库绝对路径映射到副本。其他字段不进行全局替换。发现尚未适配的原库绝对路径或 UUID 引用时停止，保留备份，并将副本标为未通过。文本及二进制字节检查只能作为保守阻塞检查，不能替代各存储格式的运行时验证。

`relocation.requiresIsolatedRuntime:true` 与 `runtimeValidated:false` 必须由后续流程处理：使用独立 Wiki 用户配置／注册表打开验证副本，不使用原库的全局注册表，不在恢复备份内启动 Wiki。LanceDB 等索引在本步骤只进行离线字节复制，没有宣称执行了真实数据库检索或重启检查。

固定上游 `file_sync.rs` 只读取正式的 `file-change-queue.json` 和 `file-snapshot.json`。同目录下严格匹配 `.(file-change-queue|file-snapshot).json.<数字时间戳>.tmp` 的原子写入残留不是运行时输入，保留在原库、完整备份及副本中，不修改其内容、不恢复其中任务，也不将其中旧身份视为活动关联。重定位报告通过 `preservedTemporaryFiles` 列出这些文件。该例外不适用于其他 `.tmp`、其他目录或非数字时间戳，正式状态仍须通过完整校验。

`relocation-records.js` 按固定上游格式适配 `.llm-wiki/history/<16位十六进制键>.json`、`chats/conv_*.json` 和 `review.json`：文件历史的 `path`、聊天的 `contextFiles/references.path`、审核的 `sourcePath/affectedPages` 只允许库内安全路径，绝对路径绑定至副本，相对路径保持库内语义。聊天正文、历史版本正文及已识别的说明文字逐值保留，不做全局替换；这些历史文本中提到原库路径不作为活动状态引用。未知字段中的原库路径／身份、非法结构、越界路径仍阻止启用。三个格式定义文件纳入源码指纹核验。报告以 `preservedHistoricalText` 明确正文保留行为。

后续迁移应重新校验报告、原库基线与恢复备份；恢复应先保存失败现场与新内容，再复制到独立恢复位置。任何恢复过程不得直接把恢复备份作为可写工作目录。

测试通过 HTTP 入口与临时文件系统覆盖完整内容、身份及绝对关联重定位、三份数据互不影响、重叠／已有目录、空间不足、中断、哈希不符、原库并发变化、未知引用、目录连接与硬链接。故障注入参数只存在于程序第二参数，不接受浏览器输入，不调用模型。尚未执行真实浏览器交互及 Wiki 运行时验证。
`relocateValidationCopy(..., {prepareOnly:true})` 是恢复模块使用的内部只读准备模式：完成相同格式与未知关联检查后，返回基础四个状态文件及上述记录的目标字节，键相对于 `.llm-wiki` 保留子目录，不写入任何目录。恢复器先持久化前态／后态，核验文件集合及所有字节后再应用；此开关不接受浏览器输入，不能绕过副本或原库执行验证。

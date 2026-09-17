# 验证副本迁移接口（T3）

`createMigrationService()` 返回 `buildPlan(input)`／`executeValidation(input)`，同时保留网页使用的别名 `plan`／`execute`。计划输入 `{reportPath,oldPath,newPath,writersPaused:true}`，其中 reportPath 是成功 T2 报告，路径必须在 `raw/sources/` 内并以 `.md` 结尾。执行输入 `{planId,approved:true,writersPaused:true}`。服务只保存待审核计划于当前进程内存，重启后须重新预检与审核。

公开计划返回 `mapping`、`summaryMapping`、`affectedPages`、`operations` 和 `baselineHash`；不返回知识正文。内部始终使用 `moves` 数组，本入口暂限一条源映射。执行前重新验证三份库、身份、恢复备份和完整副本基线。任何版本、路径、基线、关联异常都停止；只写 validationPath，不开放原库执行。

链接、共享关联和索引策略分别位于 `links.js`、`shared-outputs.js` 与 `indexes.js`，可通过 `createMigrationService({analyzeLinks,analyzeShared,analyzeIndex})` 注入经过验证的新适配：

- `analyzeIndex({baseline,root,oldPath,newPath,moves,changes})` 由 T5 校验固定 LanceDB 格式；仍拒绝 `.cache` 旁缓存与未支持的索引状态。
- `analyzeShared({cache,oldIdentity,outputs,relativeOutput,files})` 由 T5 核验共享来源与产出，保留其他 sources 并同步全部缓存摘要路径。
- `analyzeLinks({root,baseline,documents,moves,changes,affectedPages})` 默认应用 T4 的唯一目标等价修复，并把确定性路径变更加入 `changes:Map<项目相对路径,新全文>`；受影响 Raw 的摄取哈希及快照同步更新。未支持或歧义结构停止依赖迁移。

`source-format.js` 实现固定 0.6.11 canonical、previous-readable、legacy 摘要候选以及保守 sources YAML 数组解析。该模块仅修改 sources 前言；T4 可另行应用已审核链接路径补丁，其他知识正文逐字保留。支持唯一旧版 basename 来源简写；多摘要候选、歧义或未知 YAML 不猜测。摄取缓存保留 timestamp，映射身份和摘要产出；Raw 引用字节变化时更新内容哈希，其余哈希保留；队列只替换明确受影响路径，无关任务原样保留。快照使用实际字节 MD5、大小和实际 mtimeMs。

执行 journal 位于 `${validationPath}.migration-${planId}.json`，独占创建，位于副本外。记录 beforeBaseline、preimages（本地 base64）、已完成步骤、失败阶段、前后重扫证据、模型尝试和 afterBaseline。HTTP 返回报告不包含 preimages。失败不自动清理或隐式回滚，由 T7 根据备份与 journal 恢复；成功也不自动修改 T2 的冻结基线。后续 T6/T8 应显式维护下一批基线和审核依赖，不能重复使用旧报告静默继续。

## 真实上游验证

默认执行器从进程环境 `ORGANIZER_RESCAN_BINARY` 读取已构建的原生验证器绝对路径。Web 请求不能指定命令或参数模板。构建方式见 `scripts/upstream-rescan/README.md`。迁移前后都执行固定 0.6.11 的真实 rescan，要求 changedTasks 为空、没有 file-sync://changed 事件且队列没有 pending/processing；不能仅看退出码或空队列。上游会刷新快照时间和清理完成任务，成功检查后恢复这两个文件的验证前字节，以保留无关状态；重扫证据完整留在 journal。

Windows 也可设置 `ORGANIZER_RESCAN_WSL_DISTRIBUTION=Ubuntu-24.04`，并将 `ORGANIZER_RESCAN_BINARY` 设为该分发版内的 Linux 程序绝对路径。此时仅接受 Windows 本地盘路径，程序通过固定 `wsl.exe` 参数调用并映射到 `/mnt/<盘符>/`，不用 shell 拼接路径。选择的分发版必须挂载该盘；Web 页面仍不能修改执行器配置。

`modelGuard()` 提供生成、视觉、嵌入拒绝出口，任何尝试即使被内部捕获也使执行失败。迁移代码本身没有模型、网络或摄取依赖。`verify` 与 `checkpoint` 是受信任程序测试注入点，不从 HTTP 读取。

真实集成测试优先使用 `ORGANIZER_RESCAN_BINARY` 指定原生二进制，CI 构建完成后可设置该变量运行 `npm test`。本机也可在 PowerShell 设置 `ORGANIZER_TEST_WSL_RESCAN=1` 后 `node --test test/migration.test.js`，使用已安装隔离 WSL 验证器；`ORGANIZER_KEEP_PROOF=1` 会保留此测试创建的合成三份数据供联合前端检查。普通 `npm test` 对没有构建器的环境跳过这一外部集成测试，不能把跳过算作已验证。

2026-09-17 已对实际执行单源迁移后的合成副本调用真实 Rust 重扫，前后均无 changedTasks／变更事件。该证据不等同于完整 Tauri 桌面启动，当时仅覆盖 T3 单源能力；链接与共享索引的后续验证分别见 T4/T5，批量执行尚未开放。当时尚未开放原库执行；当前安全原库入口见 [原库执行合同](original-execution-contract.md)。

同日另将上述已迁移副本交给 `scripts/upstream-frontend` 外部模式，执行真实 `rescanProjectFileSync` 事件消费者及生成／视觉／嵌入守卫：1/1 通过，`attempts=[]`、`frontendSideEffects=[]`、Rust `changedTasks=[]`，仅出现空队列更新事件。外部结果保存在测试临时目录 `organizer-migration-NibwJ9/external-proof.json`，没有访问真实用户知识库；可使用该脚本的外部副本模式重现。

## T4 确定性链接修复

默认 `analyzeLinks` 现为 `src/links.js`。支持 Obsidian 双链/嵌入、Markdown 内联链接与图片、引用式链接定义、相对路径和百分号编码；目标路径之外的别名、锚点、链接标题和正文保持原字节。Markdown 按引用文件所在目录解析，双链按明确库内路径或唯一后缀解析；不猜测同名文件。围栏代码、行内代码、转义起始括号及 HTML 注释不作为导航；受影响 HTML、缩进代码/嵌套列表歧义等未支持结构明确阻塞。外部 URL 与绝对代码路径原样保留，不进行全库修链。

规划同时检查移动源的出链、未移动 Raw/Wiki 的反链、摘要引用，以及新路径引入的短双链歧义。每条原先唯一且有效的本地链接，在最终路径集合中必须仍唯一指向对应目标，否则计划失败。原有失效链接记录到 `links.preexistingBroken`，原有无关歧义记录到 `links.preexistingAmbiguous`；不把它们误报为迁移新增失效。锚点文本保留，当前证明的是文件目标等价，不单独重新解析全部标题或块锚点存在性。

公开计划 `links.repairs[]` 包含 `{path,finalPath,kind,before,after,targetBefore,targetAfter}`，供审核逐条显示；`links.newlyBroken` 成功时为空。歧义错误包含 `path/candidates/affectedItemIds`，单源入口停止该依赖迁移，T6 可据依赖项排除后重新规划全批。`changes` 仍是旧项目相对路径到最终全文的 Map，修复与 sources 前言更新组合；不会重新生成知识正文。

所有引用修复文件进入 `affectedPages` 并验证、更新 MD5 快照。Raw 正文因路径修复改变时，已有摄取项仅更新 SHA256，保留时间与成果关联；未摄取引用文件列入 `uncachedReferences`，不伪造缓存记录。现有受影响缓存或快照过期时拒绝迁移。公开审核方案列明所有受影响路径，执行仍仅作用于验证副本，原库/恢复备份哈希不变。

验证：新增 HTTP 批次场景覆盖导航双链、同名歧义、相对图片、别名/锚点/标题、引用式链接、旧失效、未移动 Raw/Wiki、缺少摄取缓存的导航及 CRLF 保留。2026-09-17 显式 WSL 真实 Rust 重扫该链接迁移副本通过，迁移后 changedTasks 和模型尝试均为空；该证据不替代后续共享索引/批量支持验证。
## T5 共享产出与真实索引

`shared-outputs.js` 将缓存视为多来源到多产出的关系：核验共享来源仍存在且内容匹配，移动摘要时遍历全部缓存的 `filesWritten`，保留所有来源的 hash/timestamp 和其他产出。Wiki sources 只替换当前映射来源，保留其他来源与知识正文。计划报告 `associations.sharedSources`、`updatedCaches`，执行页直接展示这些关联变更。

`indexes.js` 把索引分为只读分析与执行校验：`analyzeIndexes({baseline,root,moves,changes})` 返回内部冻结行快照、已验证磁盘路径及标识映射；`executeIndexMigration(root,indexPlan)` 在文件迁移后更新标识并重新打开数据库验证。公开报告通过 `indexPlanReport` 隐藏向量内容。原始所有数据库文件纳入迁移 journal 的 preimages，失败仍保留现场及完整恢复备份。

支持固定上游的真实 LanceDB `wiki_vectors`、`wiki_chunks_v2` Arrow schema：字符串/Uint32/非空列约束以及 Float32 固定维度向量均严格校验。仅更新 page_id 与派生 chunk_id；使用 Float32 原始位表示比较全表所有向量（包括符号零），对无关行和片段文本同样核验。执行后重新 connect/openTable，用原有向量查询新摘要标识和共享页面。实现锁定 `@lancedb/lancedb 0.27.0` 与 Arrow 18.1.0，使用 `npm ci` 安装，不需要嵌入服务。

无索引库正常运行。未知表/schema/字段元数据、孤立或歧义 page stem、新标识冲突、源 `.cache` 旁缓存均拒绝。若正文链接修复会影响已有索引片段，也暂时拒绝该材料，避免返回旧片段。受影响页面存在 `embedding-revisions/<sha256(page_id)>.revision` 时拒绝：上游此值是全文与有效嵌入配置的复合签名，未取得可验证配置时既不猜测新值，也不把旧值冒充有效。无关 revision 保持原样。这是明确兼容边界，不能宣称覆盖所有索引历史格式。

2026-09-17：真实 v1/v2 多来源合成数据库迁移测试通过，全部向量位模式与无关行保留，重连搜索返回新摘要及原共享页面。实际迁移后的共享索引副本同时通过固定上游 Rust 重扫和真实前端外部模式；`attempts=[]`、`frontendSideEffects=[]`、`changedTasks=[]`。本地证据位于临时目录 `organizer-shared-index-VzREP6/external-proof.json`。这是已核验 Arrow schema 的真实数据库验证，不等同于完整桌面重启或未来 LanceDB 版本保证。

## T4/T5 同批联合回归

`test/combined-migration.test.js` 通过 HTTP 公开规划/审核执行入口，在同一验证副本同时迁移历史 Raw、修复未移动共享来源的双链反链和移动来源的相对出链、更新两份 Raw 的 SHA256/MD5、保留共享 sources 与全部缓存产出，并迁移真实 LanceDB v1/v2 摘要标识。测试逐行对比迁移前后记录（仅允许计划中的 page_id/chunk_id 改变），验证向量、片段文本、共享知识正文、缓存时间和原库/备份均保留，重连搜索仍定位新摘要与共享页面。刻意不修改已有 Wiki 索引正文片段，保留该未适配场景的阻塞。

普通运行使用固定重扫响应，仅验证模块协作。设置 `ORGANIZER_TEST_WSL_RESCAN=1` 或 `ORGANIZER_RESCAN_BINARY` 时改为真实重扫；`ORGANIZER_KEEP_PROOF=1` 保留合成三份数据。2026-09-17，真实 WSL Rust 测试 1/1 通过，同一迁移后副本交给固定上游前端外部模式 1/1 通过，`attempts=[]`、`frontendSideEffects=[]`、`changedTasks=[]`、`error=null`。证据为临时目录 `organizer-combined-gaSJFC/external-proof.json`，不包含真实用户资料。
## T6 批量冻结、依赖与执行

`createMigrationService().buildPlan(input)`／`plan(input)` 保留单源 `oldPath/newPath`，新增 `mappings:[{id?,from,to,enabled?}]`、`exclusions:[id]` 与 `evolutionPlan`。分类演化计划重新校验目录清单、文件基线和计划哈希，再复用 `compileEvolution` 的最小空号及完整后代前缀；修改目标不能改变已确认文件名。页面 `/batch-migration` 提供导入、逐项修改、排除、重新冻结和副本执行入口。空目录本身不作为独立批次项目；仅创建选中材料所需目录，源目录仅在实际为空时移除。

一次编译所有选中映射：共享 sources、全缓存 filesWritten、队列、反链及索引使用同一冻结映射，避免 A→B→C 连续替换。源/摘要目标占位建立依赖；排除占位者会阻塞依赖者，确定到项目的歧义可阻塞该项后重新编译安全子集，无法定位的未知状态阻塞所有剩余项。公开 `items` 含 selected/excluded/blocked 及原因，`dependencies` 保留依赖关系。交换和仅大小写改名使用副本外独占 staging，索引先切换到独占临时标识再落最终标识，不覆盖现存数据。T5 的未知格式、revision、已有向量片段正文变更限制继续生效。

计划返回 `planManifestPath` 与 `logicalPlanHash`（也作兼容 `planHash`）。`${validationPath}.plan-${planId}.json` 包含完整 `logicalPlan`、`beforeBaseline`、`backupReportPath`、`backupManifestHash`、原始 `request` 和 `manifestHash`；逻辑计划中的路径为项目相对路径，已知缓存绝对产出替换为 `@library/`，队列副本身份替换为 `@project`，运行根和物理基线单独存放。`${validationPath}.active-plan.json` 指向最后一次审核计划，重新规划使旧计划失效。执行核验两份清单、备份报告哈希和磁盘基线；重启后传 `planId/planManifestPath` 可重新构造并校验计划，不依赖进程内 Map。此入口仍只支持 validation 角色；T8 必须独立审核恢复/副本证据后适配原库身份。

journal 增加 `targetRole/targetRoot/planManifestPath/planManifestHash/backupManifestHash/stagingPath`。每个操作先持久化 `intents` 再操作，完成后记录 completed；失败现场和 staging 保留，T7 必须用磁盘事实及完整备份恢复，不能只相信 completed。恢复入口应独立读取备份报告，不能要求已失败现场仍等于旧 baseline。逐项结果包括 succeeded、applied-unverified、failed、not-run、blocked、excluded；只有全批证明通过才将已应用项目标为 succeeded，有排除或阻塞时整体为 partial，不能显示全批完成。

验证覆盖重启读取、清单篡改、重新规划使旧计划失效、依赖闭包、歧义安全子集、目录完整编号、固定名称、空文件/大小写、重复内容交换、共享缓存与真实 LanceDB 两表交换，以及阶段中断现场保留。2026-09-17 批量合成副本通过真实 Rust 重扫；另经真实前端外部模式 1/1 通过，`attempts=[]`、`frontendSideEffects=[]`、`changedTasks=[]`。本地联合证据为临时目录 `organizer-migration-vplQcV/external-t6-proof.json`，不涉及真实用户知识库。

# 首次重构与共享整理批次

根页面提供 `/restructure`、`/inbox`、恢复与原库审核入口。首次重构冻结完整 `raw/sources` Markdown 范围，按原文分段及分层归并分析长材料，保留课程与章节身份；空白、噪声和仅标题材料保留原文件及既有成果。来源已有缓存即属于历史材料，不因位于根目录而按新文件处理；缺缓存但存在 Wiki 引用或队列记录时标为关联不明确，不直接改名。

## 两阶段审核

先完成全范围分析，再按有证据的材料摘要分块提出分类并归并为虚拟树。每份可靠材料只属于一个主分类，每类展示实际代表材料和查找理由。分类目录只存在于批次记录，不通过创建真实目录模拟审核。编号复用现有同名类别或分配最小空号，深层沿用完整父编号；层数由分类提议决定，只有单项路径的资源长度边界。

树通过审核后才展示可编辑文件名与分类路径。树编辑使旧文件审核和未执行分批失效；内容变化要求重新分析与审核。审核名称沿用 planning 的已确认名字规则，冲突不加后缀、不覆盖。

选中材料逐批走 T2 完整备份 → T6 验证副本 → T7 独立恢复演练 → T8 原库最终确认。后续分批重新建立三份数据基线，不能复用首批的旧基线。反链修复影响剩余材料内容时，该材料重新进入分析；未选材料、低信息及不确定材料保持可见。执行阶段不调用内容模型。

Windows 的产物目录使用独占创建的短随机名；LanceDB 在规划和写入前检查随机数据文件所需路径余量，路径过长要求改用较短的库外目录。失败保留原库、备份、验证现场和具体日志。页面展示受影响链接、索引表、逐项状态、模型尝试及重扫结果，并可转到恢复入口。

## 共享接口

`createBatchService({strategies,planning,backup,migration,recovery,original,stateDirectory})` 注册首次重构与 Inbox 策略。HTTP 为 `/api/batches/create|get|list|analyzeNext|treeAction|reviewItem|prepareSlice|validateSlice|prepareOriginal|applySlice|cancelSlice`，沿用本机会话和 16 KiB 请求上限。

创建输入为 `mode,libraryPath,sourceRoot,wikiSourcePath,configPath,artifactRoot`。变更请求只发送 `batchId,revision` 加一个材料／节点补丁或 `sliceId`；映射与证据留在服务端，不回传全路径清单执行。查询按 `cursor,limit` 分页来源和分批明细，分类树使用 `treeCursor`。每页最多 50 项，原文证据有界展示。

状态目录在知识库与来源范围之外，UUID 文件名、内容哈希、原子替换及 revision 校验避免旧审核覆盖新记录。同一进程按规范化知识库路径互斥，跨批次也不能并发写同一库；跨进程外部写入仍必须由用户暂停，T2/T8 再用完整基线核验。

长操作先记阶段，已有分析由 planning 按内容哈希复用；查询不会自动重新调用模型或移动文件。副本执行已有磁盘日志时读取旧结果，原库重复执行通过 T8 结果查询，归档由 Inbox journal 重放。原库尚未开始的中断分批可 `cancelSlice` 保留全部现场，再重新审核；原库开始后要求先查询结果或恢复。

## 名称身份同步

正式原库成功及 Inbox 归档完成后，共享层从成功结果提取映射，再调用私有 `planning.commitIdentityMappings`；无 HTTP 任意映射入口。按来源根和目标根分组，一次从原始表构造全量新状态，支持交换且不产生链式替换。跨根事务先落盘，完成后同 `executionId` 幂等。保留已确认名称、来源分析及身份历史，清除旧分类冻结路径，校验目标内容哈希；验证副本成功不会迁移原库的名称记录。

## 验收

`test/batches.test.js` 覆盖版本/磁盘复用、未知关联及真实 T2/T6/T7/T8 调用闭环；`test/restructure.test.js` 覆盖长转写、导航、课程身份、五层分类、低信息、共享正文、两批重新备份、反链变化重审、执行阶段零规划模型，以及同库两批互斥。设置 `ORGANIZER_RESCAN_BINARY` 与可选 `ORGANIZER_RESCAN_WSL_DISTRIBUTION` 后使用真实固定上游扫描；不将未配置环境时的 quiet 测试替身当作真实扫描证据。

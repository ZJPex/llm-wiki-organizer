# 验证副本迁移接口（T3）

`createMigrationService()` 返回 `buildPlan(input)`／`executeValidation(input)`，同时保留网页使用的别名 `plan`／`execute`。计划输入 `{reportPath,oldPath,newPath,writersPaused:true}`，其中 reportPath 是成功 T2 报告，路径必须在 `raw/sources/` 内并以 `.md` 结尾。执行输入 `{planId,approved:true,writersPaused:true}`。服务只保存待审核计划于当前进程内存，重启后须重新预检与审核。

公开计划返回 `mapping`、`summaryMapping`、`affectedPages`、`operations` 和 `baselineHash`；不返回知识正文。内部始终使用 `moves` 数组，本入口暂限一条源映射。执行前重新验证三份库、身份、恢复备份和完整副本基线。任何版本、路径、基线、关联异常都停止；只写 validationPath，不开放原库执行。

策略扩展点在 `migration-policy.js`，可通过 `createMigrationService({analyzeLinks,analyzeShared,analyzeIndex})` 注入经过验证的新适配：

- `analyzeIndex({baseline,root,oldPath,newPath})` 默认拒绝 LanceDB 文件和 `.cache` 旁缓存。
- `analyzeShared({cache,oldIdentity,outputs,relativeOutput})` 默认拒绝共享缓存产出；页面多来源另有明确阻塞，T5 需协同扩大该限制。
- `analyzeLinks({root,baseline,documents,moves,changes,affectedPages})` 默认拒绝任何双链、Markdown／引用式／HTML 链接，包括前言内链接。后续适配可把确定性正文变更加入 `changes:Map<项目相对路径,新全文>`，并维护受影响源的摄取哈希及快照；不能只移除拒绝检查。

`source-format.js` 实现固定 0.6.11 canonical、previous-readable、legacy 摘要候选以及保守 sources YAML 数组解析。仅修改 sources 前言，知识正文逐字保留。支持唯一旧版 basename 来源简写；多摘要候选、歧义或未知 YAML 不猜测。摄取缓存保留 timestamp 与内容哈希，映射身份和摘要产出；队列只替换明确受影响路径，无关任务原样保留。快照使用实际字节 MD5、大小和实际 mtimeMs。

执行 journal 位于 `${validationPath}.migration-${planId}.json`，独占创建，位于副本外。记录 beforeBaseline、preimages（本地 base64）、已完成步骤、失败阶段、前后重扫证据、模型尝试和 afterBaseline。HTTP 返回报告不包含 preimages。失败不自动清理或隐式回滚，由 T7 根据备份与 journal 恢复；成功也不自动修改 T2 的冻结基线。后续 T6/T8 应显式维护下一批基线和审核依赖，不能重复使用旧报告静默继续。

## 真实上游验证

默认执行器从进程环境 `ORGANIZER_RESCAN_BINARY` 读取已构建的原生验证器绝对路径。Web 请求不能指定命令或参数模板。构建方式见 `scripts/upstream-rescan/README.md`。迁移前后都执行固定 0.6.11 的真实 rescan，要求 changedTasks 为空、没有 file-sync://changed 事件且队列没有 pending/processing；不能仅看退出码或空队列。上游会刷新快照时间和清理完成任务，成功检查后恢复这两个文件的验证前字节，以保留无关状态；重扫证据完整留在 journal。

`modelGuard()` 提供生成、视觉、嵌入拒绝出口，任何尝试即使被内部捕获也使执行失败。迁移代码本身没有模型、网络或摄取依赖。`verify` 与 `checkpoint` 是受信任程序测试注入点，不从 HTTP 读取。

真实集成测试优先使用 `ORGANIZER_RESCAN_BINARY` 指定原生二进制，CI 构建完成后可设置该变量运行 `npm test`。本机也可在 PowerShell 设置 `ORGANIZER_TEST_WSL_RESCAN=1` 后 `node --test test/migration.test.js`，使用已安装隔离 WSL 验证器；`ORGANIZER_KEEP_PROOF=1` 会保留此测试创建的合成三份数据供联合前端检查。普通 `npm test` 对没有构建器的环境跳过这一外部集成测试，不能把跳过算作已验证。

2026-09-17 已对实际执行单源迁移后的合成副本调用真实 Rust 重扫，前后均无 changedTasks／变更事件。该证据不等同于完整 Tauri 桌面启动，也不覆盖尚被拒绝的向量索引、复杂链接、共享产出与批量执行。原库执行始终禁用。

同日另将上述已迁移副本交给 `scripts/upstream-frontend` 外部模式，执行真实 `rescanProjectFileSync` 事件消费者及生成／视觉／嵌入守卫：1/1 通过，`attempts=[]`、`frontendSideEffects=[]`、Rust `changedTasks=[]`，仅出现空队列更新事件。外部结果保存在测试临时目录 `organizer-migration-NibwJ9/external-proof.json`，没有访问真实用户知识库；可使用该脚本的外部副本模式重现。

# 整理器模块交接契约

运行环境：Node.js 22 及以上，ESM，无第三方运行依赖。`npm start` 启动 `src/server.mjs`，仅监听 `127.0.0.1:4317`；`npm test` 使用 `node --test`。

## T1 已实现入口

- `createApp({ inspect })` 返回未监听的 HTTP Server，默认调用 `preflight`。浏览器首先读取 `/api/session`，随后携带 `X-Organizer-Token` 和 JSON 调用 `POST /api/preflight`。新增写接口必须继续执行 Host、Origin、会话令牌检查。
- `preflight({ libraryPath, wikiSourcePath, writersPaused })` 是只读入口。返回 `schemaVersion`、`libraryPath`、`sources`、`version`、`associations`、`baseline` 和结构化 `blockers: [{code,message}]`。`sources[].identity` 是相对 `raw/sources` 的路径，不按名称或目录猜摄取状态。
- `inventory(root)` 返回 `{files:[{path,size,hash}],hash}`。路径相对根目录，分隔符为 `/`，摘要为 SHA256。包括隐藏文件、配置及附件，但不暴露文件正文；拒绝符号链接和目录连接。重复扫描检测可观察到的并发变化，不能替代停止外部写入。
- 版本核验来自指定源码目录的 `package.json` 和 `src/upstream-manifest.json` 四个适配相关文件的真实 SHA256，基线提交 `e8082119649e6a8e1cf85eaf289adcabfdf39d4e`。测试通过第二个内部参数注入指纹替身，HTTP 请求不能改变该参数。源码指纹匹配不证明知识库创建版本，也不证明迁移可用。
- 缓存为 `.llm-wiki/ingest-cache.json` 的 `entries[identity] = {hash,timestamp,filesWritten}`；摄取队列是数组；文件快照为 `{version:1,updatedAt,files}`；变更队列为 `{version:1,tasks}`。细节须继续核对上游，不能把最低结构检查当完整迁移校验。

## 后续模块边界

- `backup` 消费完整 `baseline`、明确的原库／备份／验证副本位置及停止写入证据；输出不可变备份清单，不把 T1 的 `writersPaused` 视为排他锁。
- `migration` 消费冻结的旧新路径映射、基线与完整验证证据；独立维护关联数据，禁止调用模型。T1 的 `canMigrate:false` 和 `MIGRATION_UNVERIFIED` 必须由后续真实隔离副本验证流程解决，不能通过用户复选框取消。
- `planning` 消费内容分析与分类状态，生成待审核建议，禁止自行执行文件操作。
- `batches` 管理范围、审核、冻结、备份、验证及执行状态；通过以上模块协作。新增入口可扩展 `createApp`，避免绕开现有 HTTP 安全校验。

T1 的自动测试通过真实 HTTP 服务和临时文件系统验证页面资源及入口行为；尚未执行浏览器自动点击、Wiki 重启或模型兼容验证。预检不会调用任何模型，也不会读出配置正文到报告。

## T9 内容命名接口

`createPlanningService({ generate, stateDirectory })` 导出 `analyze({ sourceRoot, identity, libraryPath, configPath })`、`confirm({ sourceRoot, identity, name, allowRenameConfirmed? })`、`list({ sourceRoot })`。`identity` 为源目录内 `/` 分隔 Markdown 相对路径；HTTP 使用 `/api/planning/analyze|confirm|list` 并沿用会话校验。后续分类器可复用条目的 `hash/kind/segments/analysis/identityHints/confirmedName`，执行器须再次校验源哈希及最终目标目录冲突，规划不执行搬动。

分析覆盖全部降权视图，按模型上下文限制分段并分层综合；原文及元数据不写回。`kind` 为 `body/navigation/title-only/blank/noise`，后三类不调用模型；不确定结果无自动命名建议。分段响应证据必须为该段的原文子串。系列号提示来自首个标题和原名，若模型遗漏则交人工。语义是否忠于全文仍须代表材料人工审核。

状态默认写入用户目录 `.llm-wiki-organizer`，按规范化源根哈希分文件，禁止放入源目录内；测试注入临时状态目录。状态仅含分析与审核结果，不保存配置或凭据。已确认名字默认固定，重启后可复用；哈希变化须重新分析。进程内串行保存，MVP 不支持多个整理器进程共同写同一状态目录。

配置读取用户指定的真实 `app-state.json`；按 `recentProjects/lastProject` 的路径找到项目 ID，再处理 `projectLlmOverrides`。启用项目覆盖时阻断 ingest 路由，否则使用 `taskModelRouting.ingestPresetId`，无选择时使用全局 `llmConfig`。上游核验依据为 `src/lib/llm-task-routing.ts`、`src/lib/project-store.ts`、`src/components/settings/preset-resolver.ts` 与 `llm-presets.ts`（本地 e808211 系列源码）。当前支持 `openai`、`deepseek`、`custom` 与登记的 `customLlmPresets` 的 Chat Completions 协议，未支持预设明确拒绝；不承诺 Anthropic、Gemini、Azure、CLI、Ollama 或全部内置预设兼容。自定义 HTTP 请求带 Wiki 保存的凭据与请求头，失败不输出响应正文或端点。

## T10 现有分类规划

命名确认后调用 `classify({ sourceRoot, identity, libraryPath, configPath, categoryRoot })`，复用 T9 全文综合分析。`categoryRoot` 是现有归档分类根目录；扫描只读目录树与可选 `.category.json`，格式为 `{ "description": "类别边界说明", "aliases": ["同义名"] }`。本任务不会创建目录或说明文件。检索先按全树名称与同义名分组选择候选，再仅将候选的说明交给模型；不读取其他 Raw 正文，也不重评已有文件归属。

`classification` 包含 `category`（唯一相对目录或 null）、`reason/evidence/considered`、`options`、`catalogRoot/catalogHash`、`finalPath` 和 `status`。内容不确定或没有可靠候选时为 `needs-review` 且无自动选择，允许用户明确改选现有分类。章节及项目身份由已确认文件名保留，分类选择要求正文主题优先。

`confirmCategory({ sourceRoot, identity, libraryPath, category })` 再次核验源哈希、分类树及说明哈希、真实目标存在性和同批计划重名，保存 `frozenPlan`：`schemaVersion/identity/sourcePath/sourceHash/name/category/categoryRoot/catalogHash/finalPath/planHash`。冻结只代表用户已审核这一方案，不构成迁移安全证明或执行授权。T12/T13 执行前必须重验源与分类基线、最终目标、备份和兼容证据；`planHash` 用 `planDigest` 对去除 `planHash` 字段后的固定计划对象计算。重新命名、重新分析或重新分类会使旧冻结方案失效。跨 sourceRoot 的批次合并后仍需统一检测目标重复。

HTTP 新增 `/api/planning/classify` 和 `/api/planning/confirmCategory`，页面展示并可修改一个主分类、预览最终路径与下载完整已保存状态。没有目录演化或 Raw 写入。

## T11 局部分类演化

`evolve({ sourceRoot, identity, libraryPath, configPath, categoryRoot, startCategory })` 从指定现有类别检查当前材料，复用全文分析。每次模型输入只有当前类别、直属类别及 T10 已检索到的相关分支，另提供当前目录文件名；不读取其他历史材料正文。响应 `canContain=true` 必须停止且无操作；只有 `parentAffected=true` 才逐级检查父节点。分类树全量目录/说明和文件哈希用于安全基线，不等于全库内容重新评估。

操作类型：`add {parent,label,files}`、`split {from,groups:[{label,files}]}`、`merge {from,to}`、`move {from,parent,label?}`，每项必须包含 `problem/benefit`。没有收益的替代分法不得调整；深度不采用固定篇数阈值。新增/拆分文件名单必须来自真实基线，未分配的材料保持原位；合并/目录迁移会自动列出全部后代目录和文件，包括隐藏文件与附件。同义类别新建被拒绝，应改为复用或合并。

独立 `src/evolution.js` 导出 `nextCategoryPath(paths,parent,label)`、`compileEvolution(catalog,baseline,operations,confirmedNames)` 和 `freezeEvolution`，供 T6 及批次复用。根级采用三位最小空号，子级在完整父编号后追加至少两位最小空号；移动后保留后代相对编号段并替换完整父前缀。缺失完整编号、同级编号冲突、重叠操作、覆盖目标或文件重名均阻塞，不猜测旧编号含义。

`confirmEvolution({ sourceRoot, libraryPath, operations, previewOnly? })` 接受用户修改/排除后的操作，重查来源、分类目录/说明及文件基线；`previewOnly:true` 返回可审核映射但不保存冻结状态。正式确认保存 `evolution.frozenPlan`，含 `categoryRoot/catalogHash/baselineHash/operations/visited/directoryMappings/newDirectories/fileMappings/planHash`。`fileMappings` 每项为 `{from,to,hash,confirmedName}`，保留已确认名字；全部路径相对分类根。程序仅保存方案，不创建分类或移动 Raw；T6 执行仍需备份、验证副本及关联迁移。多条重叠目录操作需拆为独立批次审核。

页面按中文字段展示分析摘要、原文证据、名称、分类理由和最终路径。演化支持调整类别名/父级/合并目标/问题/收益、排除整项建议、预览所有受影响路径并冻结。哈希和完整 JSON 只保留在可下载计划中。

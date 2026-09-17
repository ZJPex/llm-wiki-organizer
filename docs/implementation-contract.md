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

# LLM Wiki Organizer

LLM Wiki 外置 Raw 整理器，目标是改善 Markdown 材料命名与主题分类，并保护已有 Wiki 成果。

当前正在按 [Spec #1](https://github.com/ZJPex/llm-wiki-organizer/issues/1) 实现完整批次流程；进度与已完成验证见 [实现记录](docs/implementation-progress.md)。内容分析和分类规划使用模型建议，历史迁移使用程序化路径映射，不重新生成 Wiki 正文或嵌入。

## 设计入口

- [MVP 需求](plans/raw-organizer-mvp.md)
- [历史迁移核验](plans/raw-organizer-compatibility-audit.md)
- [图书馆分类研究](plans/raw-organizer-library-classification.md)
- [领域术语](CONTEXT.md)
- [交接状态](docs/handoff.md)

Issue 与 PR 均在本仓库管理。原项目为 [LLM Wiki](https://github.com/nashsu/llm_wiki)，本仓库独立维护，通过兼容性验证跟进其更新。
## 本地运行

需要 Node.js 22 或以上：

```sh
npm ci
npm start
```

打开终端显示的本地地址，默认 `http://127.0.0.1:4317`。服务只监听本机，并验证页面来源及会话令牌。页面中使用绝对路径；备份与验证副本必须位于知识库之外的不同目录，不能彼此嵌套。完整备份包含隐藏状态、附件、缓存及索引，不能覆盖已有目录。

内容规划只读复用 Wiki 保存的 `app-state.json`：先使用启用的项目覆盖，否则按摄取任务路由及全局配置选择模型。当前支持 OpenAI、DeepSeek 和自定义 Chat Completions 配置；其他提供商明确拒绝。规划会把待分析内容发送至用户所选模型服务。配置凭据不写入整理报告。

已确认名称和规划状态保存在用户目录 `.llm-wiki-organizer`，不写入 Raw。当前不支持多个整理器进程共享同一状态目录。分析覆盖全文分段，语义质量仍需用户根据原文证据审核。

## 历史迁移验证器

兼容基线为 llm-wiki **0.6.11**、提交 `e8082119649e6a8e1cf85eaf289adcabfdf39d4e`。需要这份 Wiki 源码和 Rust 工具链，按 [验证器构建说明](scripts/upstream-rescan/README.md) 构建真实上游重扫入口。启动整理器前设置 `ORGANIZER_RESCAN_BINARY` 为构建产物的绝对路径。例如 PowerShell：

```powershell
$env:ORGANIZER_RESCAN_BINARY = 'C:\临时构建\target\debug\organizer-upstream-rescan.exe'
npm start
```

Windows 也支持已经配置好的 WSL：设置 `ORGANIZER_RESCAN_WSL_DISTRIBUTION` 为发行版名称，并让 `ORGANIZER_RESCAN_BINARY` 指向其 Linux 绝对路径。该模式支持 Windows 本地盘上的验证副本。网页不能指定执行命令；未配置验证器时迁移停止。

迁移前必须暂停 Wiki、Obsidian 和同步程序等外部写入。用户确认配合重复哈希检查用于检测可观察变化，不构成跨进程文件锁。预检通过只说明已知格式可读取，不直接放行原库迁移。

支持的索引为固定 Arrow 结构的 LanceDB `wiki_vectors` 和 `wiki_chunks_v2`；迁移后检查向量逐值保留并重新连接检索。未知表或结构、来源歧义、受影响的 API embedding revision，以及尚不能等价维护的索引正文片段会阻止相关迁移，不通过重新嵌入补救。详细边界见 [迁移契约](docs/migration-contract.md)。

## 开发验证

`npm test` 运行临时合成知识库测试；没有配置原生验证器时，外部重扫测试会明确跳过。配置 `ORGANIZER_RESCAN_BINARY` 后再次运行可启用真实上游重扫。CI 在 Windows/Linux、Node.js 22/24 运行测试，并构建固定上游验证器。

[真实前端联合验证](scripts/upstream-frontend/README.md) 将实际迁移后的合成副本交给上游同步处理器，检查摄取、删除及模型出口；真实 LanceDB 测试另验证原向量和检索关联。这些检查覆盖固定源码和受支持数据结构，不等同于完整 Tauri 桌面启动，也不承诺兼容未来格式。

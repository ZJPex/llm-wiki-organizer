# LLM Wiki Organizer

LLM Wiki 外置 Raw 整理器，目标是改善 Markdown 材料命名与主题分类，并保护已有 Wiki 成果。

当前处于需求与设计阶段，尚未实现整理器。用户已明确暂不开发代码、增加测试或继续安装依赖。

## 设计入口

- [MVP 需求](plans/raw-organizer-mvp.md)
- [历史迁移核验](plans/raw-organizer-compatibility-audit.md)
- [图书馆分类研究](plans/raw-organizer-library-classification.md)
- [领域术语](CONTEXT.md)
- [交接状态](docs/handoff.md)

Issue 与 PR 均在本仓库管理。原项目为 https://github.com/nashsu/llm_wiki ，本仓库独立维护，后续通过兼容性验证跟进其更新。
# 本地运行

安装 Node.js 22 或以上，在本目录运行 `npm start`，打开终端显示的本地地址。页面输入知识库绝对路径及 Wiki 源码目录，确认暂停外部写入后开始只读预检。`npm test` 运行入口测试。

当前版本展示 Markdown 摄取状态、关联概况、版本证据和可下载基线报告。只读格式依据 Wiki 0.6.11 的已核验源码；历史迁移仍需独立验证，预检通过不代表可以安全迁移。

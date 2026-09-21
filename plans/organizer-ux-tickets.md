# 整理器体验升级任务索引

父规格：[Issue #16](https://github.com/ZJPex/llm-wiki-organizer/issues/16)。用户已确认拆分，9 项任务已发布，均标记 ready-for-agent。

已核验全部正文、标签和 11 条 GitHub 原生阻塞依赖；父规格正文保持不变且仍为开放状态。尚未开始功能实现。

| 任务 | Issue | 阻塞依赖 |
| --- | --- | --- |
| 保存知识库设置，并从 C 工作台开始或继续整理 | [#17](https://github.com/ZJPex/llm-wiki-organizer/issues/17) | 无，可立即开始 |
| 分析任务脱离页面运行，支持暂停及重启后续作 | [#18](https://github.com/ZJPex/llm-wiki-organizer/issues/18) | [#17](https://github.com/ZJPex/llm-wiki-organizer/issues/17) |
| 在 C 分类浏览页集中生成、编辑和确认名称与分类 | [#19](https://github.com/ZJPex/llm-wiki-organizer/issues/19) | [#17](https://github.com/ZJPex/llm-wiki-organizer/issues/17) |
| 纯新增材料一次确认归档，例外材料保留原处 | [#20](https://github.com/ZJPex/llm-wiki-organizer/issues/20) | [#19](https://github.com/ZJPex/llm-wiki-organizer/issues/19) |
| 确认历史整理方案后，自动完成备份与恢复验证 | [#21](https://github.com/ZJPex/llm-wiki-organizer/issues/21) | [#18](https://github.com/ZJPex/llm-wiki-organizer/issues/18)、[#19](https://github.com/ZJPex/llm-wiki-organizer/issues/19) |
| 一次最终确认应用整份已验证的历史方案 | [#22](https://github.com/ZJPex/llm-wiki-organizer/issues/22) | [#21](https://github.com/ZJPex/llm-wiki-organizer/issues/21) |
| 首次重构以分类树、文件方案、应用原库三次确认完成 | [#23](https://github.com/ZJPex/llm-wiki-organizer/issues/23) | [#22](https://github.com/ZJPex/llm-wiki-organizer/issues/22) |
| 来源或分类变化时只重审受影响的材料与依赖 | [#24](https://github.com/ZJPex/llm-wiki-organizer/issues/24) | [#20](https://github.com/ZJPex/llm-wiki-organizer/issues/20)、[#23](https://github.com/ZJPex/llm-wiki-organizer/issues/23) |
| 从任务记录查看部分结果，并继续失败处理或恢复 | [#25](https://github.com/ZJPex/llm-wiki-organizer/issues/25) | [#20](https://github.com/ZJPex/llm-wiki-organizer/issues/20)、[#22](https://github.com/ZJPex/llm-wiki-organizer/issues/22) |

当前可开始：#17。完成后 #18 与 #19 可并行推进；后续按各 Issue 的阻塞关系推进。

本索引只记录发布结果，不授权真实知识库迁移，也不自动启动开发。

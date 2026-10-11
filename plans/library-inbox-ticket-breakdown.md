# 知识库收件箱与智能分类任务拆分

父规格：ZJPex/llm-wiki-organizer#41。

状态：用户已批准粒度与阻塞关系，八个任务已发布为 #42—#49，均带 ready-for-agent。2026-10-11 通过 Windows 主机 GH CLI 逐项核验作者 ZJPex、正文与本地票据一致、状态 open、标签和原生阻塞关系正确。每票均包含服务、状态、界面及行为验证；保持当前界面风格。

| 任务 | 交付 | 直接前置 |
| --- | --- | --- |
| [#42](https://github.com/ZJPex/llm-wiki-organizer/issues/42)（T1） | 知识库收件箱：刷新、选择文件并完成基础整理 | 无 |
| [#43](https://github.com/ZJPex/llm-wiki-organizer/issues/43)（T2） | 接入旧分析结果并显式处理冲突 | #42 |
| [#44](https://github.com/ZJPex/llm-wiki-organizer/issues/44)（T3） | 主分类、主题标签与待定理由 | #42 |
| [#45](https://github.com/ZJPex/llm-wiki-organizer/issues/45)（T4） | 新类别提议随确认归档生效 | #44、#34 |
| [#46](https://github.com/ZJPex/llm-wiki-organizer/issues/46)（T5） | 显式保存知识库规则并用于后续材料 | #44 |
| [#47](https://github.com/ZJPex/llm-wiki-organizer/issues/47)（T6） | 分析中刷新追加并保护已完成结果 | #42、#38 |
| [#48](https://github.com/ZJPex/llm-wiki-organizer/issues/48)（T7） | 自动安全暂停、部分归档与复核续作 | #45、#47、#37、#39 |
| [#49](https://github.com/ZJPex/llm-wiki-organizer/issues/49)（T8） | 整合知识库进度、恢复及完整流程验收 | #43、#46、#48、#40 |

## 拆分与既有任务的关系

- 2026-10-11 已通过 Windows 主机 GH CLI 核验身份 ZJPex，并读取 #41、#34—#40 的正文、标签、状态和评论；它们均开放且无评论，不能视为已完成能力。
- #34—#40 保留原范围，不重复建并发、检查点、故障重试或调用计量任务；新票负责将其能力接入知识库和文件级操作。
- T6 的 #38 已传递依赖 #36，不重复建立 #36 的直接阻塞边。
- T7 的 #37 提供重试与故障状态，#39 提供安全部分归档及基线复核；两者均是自动协调所需前置。
- T8 的 #40 负责既有生命周期统计；新票负责知识库视图、追加和旧结果接入后的口径集成，不延后前序票必需的基本进度和操作反馈。
- 初始可开始 T1；既有 #34 也可按原任务推进。必要的内部适配放进对应首个完整功能切片，不单独制造纯重构票。
- 已按依赖顺序发布，正文引用父规格及实际前置编号，并建立原生阻塞关系；父规格保持不变，未修改或关闭既有任务正文与状态。

## 完整票据与发布记录

八份逐票发布正文位于 `.scratch/library-inbox-tickets/issues/`，采用父规格、交付行为、验收标准、前置依赖四节模板，未包含实现文件路径或代码片段。编号映射记录在 `.scratch/library-inbox-tickets/published.json`。

用户已回复“合适”，批准当前粒度、阻塞关系和发布。下一可开始的新任务为 #42；本次未实施业务功能。

# 2026-10-11 全页面风格复核

用户反馈：部分打开的页面风格不同，Logo 和图标随意。本轮将验收范围扩展到所有正式页面的公共外壳与控件，保留 B2/B3/B4 主页面的布局和原有业务流程。

## 改动与对照

- 页头统一使用书本标志；导航、任务、材料、目录统一使用本地 SVG，均为 24×24 画布、1.7 描边。移除原先混用的 Unicode 图形与各自手画的文件轮廓。
- 字体、颜色、间距、按钮、输入框、焦点与响应式导航由 `app.css` 共用；报告、恢复、备份与迁移等专用页使用同一个服务器外壳。
- 专用页可以直达设置和分类；批次列表失败不会阻挡这两个入口。任务直达链接仍优先进入对应任务。
- 批量迁移路径和任务报告的表格在窄屏局部滚动，避免全页横向溢出或挤窄路径字段。

原版专用页：[恢复](../screenshots/recovery.jpg)、[兼容检查](../screenshots/preflight.jpg)。新版：[恢复](recovery-desktop.jpg)、[兼容检查](preflight-desktop.jpg)，与[首页](home-desktop.jpg)、[阅读](reading-desktop.jpg)、[分类](categories-desktop.jpg)使用同一套视觉语言。

## 浏览器核验

使用 `scripts/ui-review-fixture.mjs` 启动临时合成知识库，固定模型替身。12 份收件箱材料、11 份可审核、1 份证据不足；本轮未归档，因此报告如实显示成功 0、保留 1、待处理 11。未调用付费模型，也未提交真实库表单。

桌面视口 1536×1024，逐页检查：

| 页面 | 截图 |
| --- | --- |
| 任务首页、设置 | [首页](home-desktop.jpg)、[设置](settings-desktop.jpg) |
| 集中审核、分类 | [阅读](reading-desktop.jpg)、[分类](categories-desktop.jpg) |
| 任务报告、恢复、兼容检查 | [报告](report-desktop.jpg)、[恢复](recovery-desktop.jpg)、[兼容检查](preflight-desktop.jpg) |
| 完整备份、单文件迁移 | [备份](backup-desktop.jpg)、[迁移](migration-desktop.jpg) |
| 批量迁移、原库执行 | [批量迁移](batch-migration-desktop.jpg)、[原库执行](original-desktop.jpg) |
| 日常整理、首次重构专用入口 | [日常整理](inbox-desktop.jpg)、[首次重构](restructure-desktop.jpg) |

窄屏视口 390×844（扣除滚动条后内容宽 375）：[分类](categories-mobile.jpg)、[恢复](recovery-mobile.jpg)、[批量迁移](batch-migration-mobile.jpg)、[报告](report-mobile.jpg)、[设置](settings-mobile.jpg)、[审核队列](reading-mobile.jpg)、[正文](reading-mobile-content.jpg)。这些页面的文档滚动宽度均等于内容宽度 375；表格保留局部滚动。

## 测试与审查

公共 HTTP 导航测试覆盖 10 个正式页面与 7 个 SVG 资源；入口测试覆盖只读导航、批次读取失败隔离及 `batchId` 优先级。相关初轮 29/29；导航修复后相关 19/19。

Standards 独立审查：明文违反 0、需要处理的重复逻辑或无必要抽象 0。Spec 初轮发现 1 项 P2（无关任务读取阻挡导航），由单一实现者修复，新增失败场景先红后绿；独立复核 13/13，遗留 0。

业务安全确认、表单字段、事件绑定和执行 API 保持原有边界；CSP 未放宽，SVG 和 CSS 通过明确静态资源白名单提供。本地 Node v25.9.0 最终全量：241 项，236 通过、5 跳过、0 失败（279 秒）；跳过项依赖真实 Rust rescan 二进制，当前提交 CI 另行验证。最终提交 CI 结果见 PR #33 的当前记录。旧验收的实际归档证据继续保留，但不将它当成本轮新归档结果。

## 第二轮：恢复图标与导航可见性

- 重新绘制恢复图标的圆弧、回转箭头与时针，保持原有 24×24 画布和 1.7 描边。
- 桌面页头保持在顶部，侧栏高度绑定窗口可用高度，两个底部入口不会随正文增长下沉。极矮窗口允许侧栏独立滚动；窄屏仍使用自然换行布局。
- 1366×768、设备像素比 1：原长首页导航底部位于 y=1201.5；修正后位于 y=748，滚动正文后位置不变。1024×600 窗口底部为 y=580，无侧栏滚动。390×844 窄屏导航为静态布局，内容宽与滚动宽均为 375。
- 证据：[桌面](navigation-fixed-desktop.jpg)、[正文滚动后](navigation-fixed-scrolled.jpg)、[窄屏](navigation-fixed-mobile.jpg)。截图只展示空白恢复表单，未提交任何恢复操作。
- 本轮相关页面测试 22/22；Standards 与 Spec 独立复核均无新增发现。仅修改公共 CSS 和恢复 SVG；当前提交 CI 结果见 PR #33。
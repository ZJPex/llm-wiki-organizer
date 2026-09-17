# 固定上游真实重扫验证器

这是 llm-wiki 0.6.11（e8082119649e6a8e1cf85eaf289adcabfdf39d4e）的 Rust 重扫集成入口。prepare.mjs 校验 file_sync.rs 和默认监控配置的 LF 规范化 SHA256，将源码复制到全新临时构建目录。仅移除 Tauri command 属性、替换事件总线导入和 include 路径；文件遍历、MD5、快照读取、队列生成和处理均使用原实现。事件总线只记录事件，panic 边界只转交并捕获 panic。

## 构建与执行

```sh
node scripts/upstream-rescan/prepare.mjs /path/to/llm-wiki /tmp/fresh-rescan-build
cargo test --locked --manifest-path /tmp/fresh-rescan-build/Cargo.toml
cargo build --locked --manifest-path /tmp/fresh-rescan-build/Cargo.toml
/tmp/fresh-rescan-build/target/debug/organizer-upstream-rescan --validation-copy /tmp/isolated-vault isolated-project-id
```

最后一个可选参数是 SourceWatchConfig JSON。使用真实有效监控配置，避免因过滤条件屏蔽变动。程序会写验证副本的快照和队列；只能传独立验证副本，不能传恢复备份或日常知识库。它不启动 Tauri，也不注册用户项目。

标准输出是 JSON，包含固定提交、真实 rescan 返回值和记录的事件。成功条件必须同时检查 result.changedTasks 为空、result.queue.tasks 不存在待处理项，以及无 file-sync://changed 事件；不要仅看退出码。先用故意改动的对照副本证明检查能发现 created/modified/deleted，再验证迁移后的副本。

2026-09-17 已在隔离 WSL Ubuntu-24.04 / Rust 1.98.1 执行：原文件自带的 19 项 Rust 测试及新增公开入口集成测试全部通过。新增测试验证首次 created、无变化静默、等长内容修改和未维护快照的改名会产生两项变更。没有访问真实知识库。

## 证据边界

这是真实上游 Rust 重扫算法验证，不是完整桌面重启或向量检索验证。Tauri 的事件消费者、前端摄取、模型网络出口和 LanceDB 未在本进程内运行。迁移验收还必须对实际迁移后的合成副本调用本入口，并结合模型出口守卫、上游前端事件消费者和真实向量关联检查。上游已有前端 project-file-sync.test.ts 模拟了 rescan，不能替代本证据。未知版本或源码哈希不符直接拒绝生成。

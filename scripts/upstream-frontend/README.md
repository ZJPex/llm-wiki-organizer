# 上游前端消费真实重扫结果

固定 e8082119649e6a8e1cf85eaf289adcabfdf39d4e 的 project-file-sync.ts，读取真实 Rust harness 的 JSON 返回值，调用真实 rescanProjectFileSync。没有伪造 changedTasks。源文件哈希在 fingerprints.json；prepare 在创建全新运行目录前校验。

```sh
node scripts/upstream-frontend/prepare.mjs /path/to/upstream /tmp/fresh-frontend-proof
cd /tmp/fresh-frontend-proof
npm install --ignore-scripts --no-audit --no-fund
UPSTREAM_RESCAN_COMMAND='["/path/to/organizer-upstream-rescan"]' npx vitest run --config vitest.config.mjs
```

Windows 调用 WSL 二进制时，设置 UPSTREAM_RESCAN_WSL=1（将临时目录转换为 /mnt/<drive>/），UPSTREAM_RESCAN_COMMAND 为 `["wsl.exe","-d","Ubuntu-24.04","--","/tmp/organizer-spec-1/rescan-target/debug/organizer-upstream-rescan"]`。必须先构建 scripts/upstream-rescan 的固定 Rust 程序。

测试只创建临时合成库。原始扫描建立快照后，无变化副本应无任务且零危险入口；短文件改名应由真实扫描引出上游删除和摄取尝试；长文件改名应引出隐式来源迁移尝试。守卫在抛错前计数，即使上游捕获异常也无法把尝试误报为零。

展示层文件树刷新和 Tauri 事件注册不启动。来源生命周期操作在调用边界阻断；生成、视觉、嵌入、fetch、Tauri HTTP/native 另有阻断守卫及独立自检。因此本工具证明真实扫描结果在固定前端会不会触发危险入口，不声称已启动完整桌面、执行真实模型 SDK 或验证 LanceDB。模型不存在请求的直接证据是摄取入口未被调用；模型守卫自检是额外保护，不应当被描述为真实模型流量测试。

2026-09-17 实测：Windows Node 25.9.0 + Vitest 4.1.4，WSL 调用固定 Rust 二进制，四项测试全部通过（约 5.4 秒）。依赖安装仅发生于全新临时运行目录，上游源码和依赖未改动。

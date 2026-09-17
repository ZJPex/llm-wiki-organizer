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

## 验证现有迁移副本

准备脚本会复制已提交的 package.json 与 package-lock.json；在全新运行目录执行 `npm ci --ignore-scripts --no-audit --no-fund`，随后按前述方式运行 Vitest。不要在脚本源码目录安装依赖。

额外提供三个环境变量：

- UPSTREAM_VALIDATION_COPY：显式验证副本绝对路径。
- UPSTREAM_VALIDATION_MANIFEST：T2 完成且校验通过的备份报告 JSON 绝对路径。
- UPSTREAM_VALIDATION_RESULT：尚不存在的输出 JSON 绝对路径，必须位于三份数据之外。

外部模式核验三份目录不重叠、报告身份与三个 project.json 一致、副本 UUID 独立且没有符号链接/硬链接。只运行现有副本验证，不建立初始快照、不删除副本。输出含 attempts、frontendSideEffects、rustProof 及 error；副作用被上游捕获后仍会记录并令测试失败。输出采用独占创建防止覆盖既有证据。

2026-09-17 外部模式实测通过：真实 Rust + 上游前端零副作用，外部副本与报告保留。安全入口测试覆盖原库/备份路径、相对路径、库内报告与身份相同拒绝；原四项对照回归通过。
# 恢复目录验证

`UPSTREAM_VALIDATION_MANIFEST` 也可指向 T7 成功恢复的 `.result.json`，此时 `UPSTREAM_VALIDATION_COPY` 必须是报告中的全新独立恢复目录。工具只接受验证副本角色的独立目录恢复，校验恢复报告、恢复计划、迁移日志、备份证据链，以及完整恢复与备份内容；拒绝原库与恢复备份。完整契约见 `docs/recovery-contract.md`。

外部模式会在真实上游扫描后恢复 `file-snapshot.json` 和 `file-change-queue.json` 原字节，报告 `stateHashes.before/after`，所以验证不会使成功迁移或恢复的内容基线失效。

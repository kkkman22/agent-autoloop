# 2026-11-18 全量修复与性能优化实施计划

**状态：执行中。** 基线 `871e778`（Apple M6 / Node v24.22.1）。

## 目标与验收标准

1. **消除 `/v1/state` 与 `/v1/metrics` 历史扫描（真 `O(1)`）**
   - `kernel/evolve.ts`：`deliveries` 复合索引 `["channel", "card_id"]` + 部分索引 `projection_delivery_trouble`（仅覆盖 `given_up = 1 OR error IS NOT NULL`）+ 派生计数表 `projection_sources(source, count)`。
   - `host/state.ts`：按配置通道逆序 `LIMIT 1` 取最新投递，消除全表双扫与临时 Bloom Filter；`sources` 事件数读 `projection_sources`。
   - `host/metrics.ts`：`deliveries` 汇总加 `WHERE given_up = 1 OR error IS NOT NULL` 走部分索引。
   - `scripts/history.ts`：重建一致性哈希补齐 `projection_tallies` 与 `projection_sources`。
   - **验收**：历史增长 5 倍时 `/v1/state` 与 `/v1/metrics` 延迟保持常数级，重建前后所有投影哈希一致。

2. **消除深队列 `O(W × Q)` 写放大与 `blockedClaim` 全表扫**
   - `kernel/evolve.ts`：`Match` 支持 `{ gt?, lte? }` 范围条件（内存 overlay `accepts()` 与 SQL `json_extract` 同步）；`runs` 新增复合索引 `["state", "not_before", "id"]`、`["agent", "state", "id"]`、`["rule", "state", "id"]`。
   - `kernel/due.ts`：`retry` 只查 `{ state: "queued", not_before: { gt: iso(now) } }`；循环外单次读 `claimed`；每个 `worker` 按名下 `agent` 各取 `LIMIT 1` 就绪轮次（离线卡片已关时再按 `created_at: { gt: card.closed_at }` 取 `LIMIT 1` 传给 `offlineCard()`）。
   - `kernel/decide.ts`：`claimNext()` 先筛候选规则（满组直接返回 `null`，零 `queued` 查询），再按候选规则取 `LIMIT (组已占槽位 + 1)` 选跨规则最小 `id` 且 lane 空闲的轮次。
   - `sim/mutate.ts`：同步变异片段，确保原版全过且全部变异 100% 非语法错误并被检出。
   - **验收**：5000 排队深度下 `ingest` / `claim` / `finish` / `blockedClaim` 降回毫秒级，`tests/queue-costs.test.ts` 通过。

3. **长轮询分流唤醒、`arm()` 防抖、外壳 SQL 预编译缓存与单次鉴权**
   - `host/runtime.ts`：`all()`、`one()`、`logAfter()` 复用 `statement(db, sql)`。
   - `kernel/http.ts` & `host/server.ts`：`wait(until, signal, kind?)` 区分 `"work"` 与 `"card"` 按变更表精准唤醒；`arm()` 微任务防抖并用循环求最小值避免大数组展开栈风险。
   - `kernel/evolve.ts`、`kernel/credentials.ts` & `host/server.ts`：`View` 缓存基础 `keys` 行，单次请求只读一次 `keys`。
   - **验收**：通道动作不惊醒 `/v1/work`，轮次心跳不惊醒 `/v1/cards/next`，限流与轮次令牌行为不变。

4. **Worker 退避、异步进程组探针、单轮读取合并与 `usage/` 清理**
   - `worker/worker.ts`：`settle()` 对 `HubError` `status >= 500` 退避 `BUSY_PAUSE`（30s）；`groupAlive()` 改异步 `execFileAsync`；合并每轮 `entries()` 扫描；`tidy()` 调 `tidyUsage()`。
   - `worker/usage.ts`：`loadUsage()` 刷新 `mtime` 防误删长寿续接会话，`tidyUsage()` 清理超 14 天未更新文件。
   - **验收**：`500` 退避不紧循环重打，超期 `usage/*.json` 清理且活跃会话保留。

5. **GitLab 交付补齐、审查超时封顶与临时目录清理、纯洁性测试加固**
   - `plugins/delivery/gitlab.ts`：移植 `fetched` + `localCommit()` 缓存、`prepareShip()`，列表 API 补分页。
   - `plugins/delivery/review.ts` & `plugins/delivery/run.ts`：单审查器超时受剩余轮次预算约束；启动清理超 6 小时无活进程残留 `agent-autoloop-delivery-*` 并挂信号清理。
   - `tests/purity.test.ts`：递归扫描全部 `.ts` 文件。
   - **验收**：GitLab 同 SHA 不重复 `git fetch`，分页生效，纯洁性全仓递归通过。

6. **基准补盲、文档同步、全量验证与独立 Agent 盲审**
   - `scripts/benchmark.ts`：补充带容量（`capacity=1`）并发长轮询唤醒观测。
   - `docs/protocol.md`、`README.md`、`README.en.md`：移除旧硬门槛表、同步内核行数与最新实测数据、补齐 `scripts/history.ts` 说明。
   - **验收**：`typecheck`、`format:check`、`npm test`、`npm run test:nightly`、`scripts/history.ts 1000 5000` 全绿，独立 Agent 盲审闭环。

## 阶段进度

- [x] 阶段 0：计划落盘与任务台账
- [x] 阶段 1：消除 `/v1/state` 与 `/v1/metrics` 的历史扫描（`tests/tallies.test.ts` 新增来源计数与通道投递一致性测试）
- [x] 阶段 2：消除深队列 `O(W × Q)` 写放大与 `blockedClaim` 全表扫（`tests/queue-costs.test.ts` 新增行数常数级测试；期间模拟抓出并修复组并发跨 worker 计数 bug；变异 36/36 检出）
- [x] 阶段 3：长轮询分流唤醒、`arm()` 防抖、外壳 SQL 预编译缓存与单次鉴权（`tests/http.test.ts` 新增唤醒分流测试）
- [x] 阶段 4：Worker HTTP 5xx 退避、异步进程组探针、单轮读取合并与 `usage/` 超期清理（`tests/worker.test.ts`、`tests/worker-tidy.test.ts` 新增）
- [x] 阶段 5：GitLab 交付缓存与分页补齐、审查超时封顶与临时目录清理、纯洁性测试递归扫描（`tests/delivery-run.test.ts`、`tests/delivery-review.test.ts` 新增）
- [x] 阶段 6：基准补盲、文档同步、全量验证与独立 Agent 盲审闭环（`npm test` 968/968、`npm run test:nightly` 通过、变异 36/36、`history.ts 1000 5000` 复测通过）

## 实测效果（Apple M6 / Node 24.22.1）

| 场景                            |                                 改前 |            改后 |
| ------------------------------- | -----------------------------------: | --------------: |
| 排队 5000 收事件 P50            |                              24.6 ms |         0.89 ms |
| 排队 5000 领活 P50              |                              33.0 ms |         1.27 ms |
| 排队 5000 交回执 P50            |                              24.4 ms |         0.83 ms |
| 排队 5000 组满空领活 P50        |                              10.4 ms |         0.44 ms |
| `/v1/state` P50（5.5 万条事实） | 13.6 ms（1.1 万条时 4.5 ms，线性涨） | 1.72 ms（常数） |

修复过程中额外抓到并修掉：新 `claimNext` 首版把组并发占用只按本 worker 统计，20 万步模拟第 65 步抓出「超出同组并发数」，已改为跨 worker 共享计数。

## 独立盲审结论（2026-11-18，未参与编码的 Agent 只看 diff）

无必须修项。三条关键等价性均核实：排队轮次的 `agent` 字段与最新规则恒同步（入队、规则变更、重试重排三条路径都重指）；`claimNext` 新旧候选语义等价（cron/暂停/删除/`maxActive`/跨 worker 组占用/busy lane/LIMIT 界均逐一比对）；`deadlines`/`offlineCard`/`hasNewer` 与旧 `waiting` 全量语义分解等价。变异 36 处守卫与重构后代码逐条对应。

审查 Note 的处理：

- 采纳：交付临时目录清理阈值从 6 小时放宽到 24 小时并写明与 `timeout` 配置的关系（长审查期间根目录 mtime 不更新，6 小时在自定义长超时下有误删边界）。
- 记录不修（仓规：罕见条件凑一起，无事故依据）：组上限查找基准从 run 的陈旧 `grp` 字段换成规则当前 `group`，组改名瞬间新旧混合队列两版计数法各有近似，未发现超发路径；GitLab 标签事件查询仍单页（阈值从 20 提到 100，超 100 条事件的议题取到的标记事件可能偏旧，属原有类问题）；`loadOf` 每 agent 两次索引查询，几十个 agent 挂同一 worker 时 tick 成本线性放大；SIGTERM 处理器与垂死子进程并发清理，`rmSync(force)` 容忍半删。

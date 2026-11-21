# 2026-11-21 全量审计 + 性能实测批

**状态：进行中。** 审批过的范围：全项目审核修错、文档同步、性能实测与按实测取舍的优化。

全量审计 kernel/host/worker/protocol/cli/plugins/sim（内核亲读 + 三路探查，每条发现对源码核实）。「这些算出错」清单逐条过，均干净；上游 14 个合并提交（用量上限扣留、规则换组、时区重算、安装器、翻页、来源名校验）由测试护着，未发现必修错。基线：test:quick 970 过 0 挂（21 条平台条件跳过）。工作区遗留的 tests/cards.test.ts 结构修复（缺 `});` 把下一个测试嵌套成子测试）先行落地（d98fdc2）。

## 必修

1. **手动轮被合并后丢失 go-ahead** — kernel/decide.ts retryLater 合并环：同规则同 lane 的轮在跑时，本人手动运行新建排队的 manual 轮；该轮失败把 manual 轮合并进来时，`manual` 和 `not_before: now` 都丢了。失败密集、用量受限时——恰是文档承诺「想提前试，手动运行一轮」的场景——静默失效。修：合并环保留 `other.manual`。
2. **manual 永不过期** — failure 补丁不清 `manual`：一轮手动触发过，之后每次自动重试都被当成本人探测，绕过配额扣留。修：failure 补丁默认 `manual: null`，仅当合并进来的排队轮是 manual 时保留。

两项同一语义：manual = 本人要的下一次派发。测试先行：tests/usage-limit.test.ts。

## 记录不修（仓规：罕见条件凑一起的记下来，有人碰到再修）

- 提前恢复只释放 `not_before === held.until` 的轮（decide.ts:669）：自身退避更长（尝试 ≥4、40-60 分钟）且限窗更短的轮不放，与 protocol.md「碰到上限的那几轮也马上接着派」有出入。需短限窗 + 高尝试数 + 早恢复三个条件凑齐。
- 跨账号同毫秒撞 `limit:<until>` 卡片键（decide.ts:563）：第二个 agent 不出卡；第一个提前恢复时共享卡提前关掉。同账号同刻是设计（一张卡），跨账号撞毫秒是巧合场景。
- claimNext 内层 `held` 遮蔽外层（decide.ts:380/423）：现在正确但易误读，顺手改名（随必修提交）。

## 性能（先测、后改、复测、如实记录；无实测收益即回退）

基线（本机，node scripts/benchmark.ts / --busy、scripts/history.ts 1000 5000、test:sim steps/s），每项优化独立复测。候选：

- host/metrics.ts 开卡计数读全行进 JS → SQL COUNT。
- host/server.ts logStream 每事实一次 SQL → 每次唤醒批量取（SSE 逐条、背压、密钥复查不变）。
- kernel/query.ts loadOf 每 worker 全量扫 claimed（deadlines 与 sweep 各一遍）→ 一次扫描按 worker 分组。
- kernel/decide.ts due 表 diff 每行两次 JSON.stringify → 字段直比。

不碰：逐条落盘提交（口径的一部分）、per-row Object.freeze、空转长轮询的 BEGIN IMMEDIATE（busy 实测已够快，只记录）。内核项过了 `npm test` 全量与 test:nightly 才留。

## 验收

- 两个失败测试先红后绿；test:quick、typecheck、format:check 过；内核改动跑 `npm test`（20 万步模拟 + 穷举）与 test:nightly。
- 性能数字本机实测、前后可比，「无变化」也如实记；README 两份实测表与行数、protocol.md 历史增长实测同步。
- CHANGELOG 未发布节补「修好的」两条。

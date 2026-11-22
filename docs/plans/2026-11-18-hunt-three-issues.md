# 2026-11-18 hunt 报的三个问题(已审批方案,不提交)

来源:下游 hunt 工作站维护 agent 的报告,附本机 `~/.agent-autoloop/` 实证。

## 问题 1:worker 轮结束缺终态行 → 结论:不是 bug,不改代码

- run 121:stdout 512 行,`turn.started` 第 2 行,`turn.completed` 是最后一行(mtime 08:45:06Z);stderr 08:44:43Z 仍有工具调用。进程 08:45:16Z 退出(exit-1 mtime),up.log `run 121: done` 08:45:16.800Z——同秒。
- 报告写于 08:30~08:45 之间(run 125 已启动、121 未完),落在 53 分钟合法运行窗口内。
- 全量扫描 up.log:started 无终态的只剩 run 127(当时仍在跑)。
- 代码核对:conclude 所有出口 endWith → settle → 终态行;非法回执走 problem/repair/discardReceipt,不抛异常。
- 建议 hunt:卡死检测用 `GET /v1/events/<id>` 的 runs[].state 或 /v1/state,别只盯 started/终态差(长轮默认上限 180 分钟)。

## 问题 2 → PR ① `claude/cross-group-resolve`

规则级 `crossGroup: true`(默认关):该规则一轮的 context.open 与回执 resolve 范围放宽为「同来源+任意组+领取前」。保留 source 过滤与 created_at<=claimed_at。

先写失败测试:

- tests/cards.test.ts:①crossGroup 轮 open 看得到别组 open 卡且 resolve 能结;②crossGroup 轮结不了领取后新开的别组卡。现有 383 行测试不动。
- tests/rules.test.ts:crossGroup 非 boolean 报错(problem 模式)。

实现:

- kernel/rules.ts:RuleOptions + `crossGroup?: boolean`
- protocol/rules.ts:字段白名单 + `["crossGroup", boolean, "只能是 true 或 false", true]`
- kernel/query.ts:openInScope 按 run.rules_version 查规则,置旗标去 grp 过滤;jobOf 透传
- protocol/job.ts:Job rule Pick + "crossGroup"
- worker/contract.ts:提示词 open 措辞按 flag 分支
- docs/protocol.md:规则字段段(~L108)、L257 open 描述、L302 resolve 范围 + 兼容说明

兼容:新中台读旧规则无感;旧中台按「多余字段」拒收整份规则文件(字段白名单)→ 先升中台再改规则文件(同 receipt fyi 说明)。回执协议/日志/投影格式不变。

## 问题 3 → PR ② `claude/document-emit-queue`(docs-only)

docs/protocol.md 来源段(~L147)加:routed 只表示接了;同事项在跑/排队的轮会并进去;何时新开由 parallel/组上限/接单程序容量决定;进度用 GET /v1/events/<编号>(runs[].state)轮询。不改代码不改应答。

## 验证

- 两 PR:test:quick + typecheck + format:check;PR① 另跑全量 npm test(动 kernel/protocol)。
- PR 正文:问题/改后行为/验证结果/兼容影响。

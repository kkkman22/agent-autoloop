# 《多 Agent 架构演进与 IM 交互闭环设计报告》撰写计划

## Context

现有体系是「IM → omb-bridge(7 通道)→ OpenMausBot(6 角色团队)」+ autoloop 经 `omb-agent.mjs` 适配器包住 OMB 做无人值守。要论证:裁撤 OMB 常驻层,改为 **omb-bridge + agent-autoloop + MCP(agent-hud-open)**,并设计 IM 端全生命周期交互闭环。产出一份设计报告(纯文档,不改代码)。

## 调研基础(已完成)

- **agent-autoloop**(本仓):`docs/protocol.md` 全读 —— 事件/规则/事项/轮次/回执/卡片六词、ask 卡片+answer 唤醒、`ref` 卡片原地 PATCH、幂等键、暂停/恢复/立即运行、`/v1/state`+`/v1/stream` 客户端模式、内置 MCP(status/why/answer/resolve/stop/emit/tell)、失败重试矩阵(第 3 次告警/第 10 次取消);`plugins/feishu/channel.ts`(lark-cli 长连接+patch+幂等键)、webhook 通道(钉钉/企微/Slack/Discord 模板)。
- **omb-bridge**:`src/channels/types.ts` 通道契约(QuestionBody.meta=关联 ID 载体)、`bridge.ts/omb.ts` 职责、`examples/omb-agent.mjs`(exit3→ask/exit4→later/代答回流)、`docs/plans/` 三方集成计划(TC-01~06,11-08 执行中)。
- **OpenMausBot**:定位(聊天式 bot 军团,无看板)、MCP server 17 工具与 wait_for_conversation 契约、headless CLI/respond API(bridge 的现有依赖)、既有选型调研(2026-10-31)。
- **agent-hud-open**:后台 Explore 调研中,产出 `~/code/agent-hud-open-survey-2026-11-08.md`;写报告时并入模块三,未回的部分如实标「未核实」。

## 交付物

1. 主报告:`/Users/gruby/code/omb-bridge/docs/plans/2026-11-08-omb-sunset-and-im-loop-report.md`(中文大白话,约 600~900 行;含 2 张 Mermaid 图:系统拓扑 + 端到端时序;含证据索引,逐条结论标来源文件/URL)
2. 聊天回复:结论摘要(判定 + 迁移三阶段 + 盲区清单)

## 报告大纲(按需求五模块)

- **模块一 瘦身论证**:OMB 三能力(角色管理/Thread 状态机/响应注入)↔ autoloop 平替矩阵(规则+agents 表 ↔ team.yaml;事项+轮次+会话续接 ↔ thread 状态机;ask/answer/later ↔ respond 代答);诚实列出盲区(多 bot 同室协作、Auto 路由、bot 人设、OMB 移动 App——分别给出替代或取舍);复杂度对比(常驻进程数、排错面、Token)。
- **模块二 四条 IM 链路**(协议/时序/防刷屏三层):
  1. 任务发布:bridge 收 IM → 会话映射/鉴权(answerers+roles)→ `POST /v1/events`(source 角色)→ 规则派活;意图解析与分工放「PM 规则 Agent」的回执 events(emits 白名单),不进 bridge。
  2. 进度感知:进度卡=bridge 作 `/v1/state`+`/v1/stream` 客户端,单卡 PATCH 原地热更新(对齐飞书 patch/幂等键机制,给出节流与聚合规则);追问「卡在哪」→ bridge 拦截问句 → 查 state → 回帖。
  3. HITL:autoloop 原生 ask 卡片挂起(一轮不等人);correlation = card.id+ref+by 三重核对(已有);bridge 的按钮 meta 即 interrupt_id;answer → 唤醒原事项原会话。
  4. 异常干预:连续失败 3/10 次策略、`stop`/`cancel`、规则 pause;IM 文字指令(停/暂停/查)→ bridge 命令路由 → 本人密钥接口;死循环判定靠 worker 超时+心跳不确定态。
- **模块三 agent-hud-open 专项**:MCP 工具清单、handoff 机制、明确其无南北向外联(为什么 bridge 不可替代)、Tauri 桌面依赖对 daemon 化的障碍——以后台调研结果为准,未核实处标注。
- **模块四**:Mermaid 拓扑图(IM⟷bridge⟷autoloop⟷CLI Agents⟷MCP)+ 完整时序图(发任务→进度卡→挂起→审批→恢复→交付)。
- **模块五 落地**:幂等/防重放(卡片只算第一次、send_id、幂等键、409 语义);审批超时策略(不回滚不无限等:卡片 7 天效期+later 复查+人工兜底,给出推荐默认);三阶段迁移路线(①wrapper 双跑现状→②bridge 南向从 OMB CLI 换成 autoloop /v1(channel+source 双角色,`src/autoloop.ts` 取代 `src/omb.ts`)→③裁撤 serve;每阶段验收与回滚)。

## 执行步骤

1. TodoWrite 建任务清单(五模块+图+索引各一项)
2. 等待/并入 agent-hud-open 调研结论(若写作时未回,先写其余模块,模块三留位,收到通知后补)
3. 写主报告(一次性落盘,分段 Write/Edit)
4. 自查:五模块齐全、Mermaid 语法可渲染、每条关键结论有来源、盲区如实
5. 聊天交付摘要

## 验证

- 大纲与需求五模块逐条对得上;两张图用 mermaid 语法校验(结构对称/无悬空节点)
- 关键机制描述与本仓 protocol.md 行为一致(引用章节),不发明不存在的接口
- 不改任何代码;OMB 裁撤结论带条件与回滚,不写成无脑砍

## 未决(默认按此执行,可在审批时改)

- 报告路径放 omb-bridge 仓(本报告决定的是 bridge 的去留与改造);若想跨仓中立,可改放 `~/code/` 顶层(同 2026-10-31 调研惯例)
- 结论方向:推荐「可裁撤,分三阶段」,OMB 移动 App 与聊天室体验列为已接受损失(由 IM 卡片替代)
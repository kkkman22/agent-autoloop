# 飞书群「代码实现问答」机器人(PM /测试专用)

- 日期:2026-11-12(同日修订:并发 3、连续性问题日志注入)
- 状态:已审核
- 部署:用户 Mac mini(24G/512G,24 小时工作站),不经公网

## 目标

PM/测试在飞书群里问「某功能代码里怎么实现的」,机器人用业务语言回答,**代码不出仓**:
不出现代码块、文件路径、变量名/函数名、接口路径、密钥。

## 形态

- 每个 PM/测试一个飞书群,群成员 = 机器人 + TA 本人(群白名单制,conversationId 不在名单直接忽略)
- PM 群里 @机器人 提问 → 本地 agent-autoloop 派给 Claude Code(模型 MiniMax)读 `~/code/ch5_specification` → 答案过正则闸 → 回复到该群(引用原消息)

## 关键决策(为什么这么搭)

1. **入口不走 feishu 通道插件**:现有 `plugins/feishu/channel.ts` 是卡片通道(发卡/收按钮),收不了群聊自由消息。入口用独立常驻监听进程 `listen.ts`(lark ws 长连接,免公网 IP),收 `im.message.receive_v1`,经 `POST /v1/events` 打进内核——与 `examples/recipes/jira-watch` 的 source 模式同构。
2. **出口不走卡片通道**:卡片只能发到 owner 会话,路由不到 PM 群。答案由 `answer.ts` 直接调飞书消息 API 回 `chat_id`(事件里带)。
3. **Claude Code 用包装脚本起,不用内核 claude 适配器**:答案要按 chat_id 路由+先过正则闸再发出,`use: command` 的 agent(跑 `answer.ts`)对回执/输出全可控;每个问题独立一轮,不需要会话接续。模型经环境变量指向 MiniMax 的 Anthropic 兼容端点(见「待验证」第 1 条)。
4. **一个飞书应用服务所有群**:机器人拉进 N 个群,chat_id 区分。不需要每群一个应用。
5. **并发 3,不串行**:6 人同时问时串行会让最后一人等 10 分钟以上,顶不住「端到端 < 2 分钟」。规则写 `parallel: 3` + `maxActive: 3`(只写 maxActive 提不动并发:组上限 `parallel` 默认 1)。每人(subject=sender)仍是独立一轮且同一人绝不并行两条;同一人补发且原题还没开跑时,新消息并进同一条排队 run。3 个并发 claude ≈ 2~3G 内存,mini 吃得下;真正上限是 MiniMax 并发与额度,从 3 起步按实调。
6. **连续性问题用日志注入,不开会话**:answer.ts 起 claude 前,把该 chat_id 最近 3~5 轮已过闸的问答拼进 prompt 当上下文,claude 照旧一次性跑。追问能接上,闸照走(注入的是已过闸答案)。不用 `claude --resume`:要按 chat_id 管会话文件、处理过期,复杂度不值。代价是连续题 prompt 变长,单题时间几乎不变。

## 流程

```
飞书群(机器人+PM)
   │ @机器人提问
   ▼ wss 长连接
listen.ts(常驻,launchd) ── 白名单/限流/幂等(id=消息id)
   │ POST /v1/events (Bearer source key)
   ▼
agent-autoloop 内核 ── 规则:pm.question → qa-answer,parallel 3(每人独立一轮,全局最多 3 个并发)
   ▼
answer.ts(command agent, cwd=work/feishu-qa)
   ├─ AGENT_AUTOLOOP_CONTEXT 取 {问题, chat_id, msg_id, sender}
   ├─ spawn: claude -p "<系统提示+问题>" --model MiniMax-M2.1
   │        env: ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN(指向 MiniMax)
   │        cwd: /Users/gruby/code/ch5_specification
   ├─ 正则闸:拦代码块/文件路径/变量名/密钥 → 改写「涉代码细节,已转开发」+ 通知 owner
   └─ 飞书 API 回复 chat_id(引用 msg_id);最后一条输出 = 回执
```

## 组件与任务分解

### 1. 飞书应用(前置,人工)

- 开放平台建企业自建应用:权限 `im:message`(接收群消息)+ `im:message:send_as_bot`(发消息);事件订阅选 **长连接模式**
- 机器人启用,拉进每个 PM 群;记录各群 chat_id 入白名单
- 凭证(app_id/app_secret)放 `work/feishu-qa/feishu.env`(0600)

### 2. `work/feishu-qa/listen.ts`(新写,~150 行)

- 官方 `@larksuiteoapi/node-sdk` ws 模式长连接,只处理 @机器人 的 text 消息
- 白名单:chat_id + sender_open_id 双校验;不在名单忽略且不回复
- 限流:每用户 20 问/天(本地计数文件),超了回一句「今日额度用完」
- `POST http://127.0.0.1:<port>/v1/events`,`Authorization: Bearer <来源密钥>`
  事件:`{source: "feishu-qa", type: "pm.question", id: <msg_id>, subject: <sender>, summary: <问题原文>, detail: {chat_id, msg_id}}`,id 幂等去重
- 断线自动重连;进程崩溃 launchd 拉起

### 3. `rules.json` 增量

```json
{
  "sources": { "feishu-qa": { "name": "飞书PM问答" } },
  "agents": {
    "qa-answer": {
      "name": "读码答题",
      "worker": "<实际 worker 名,对齐 config.json>",
      "use": "command",
      "command": ["node", "{cwd}/answer.ts"]
    }
  },
  "rules": [{
    "name": "PM实现问答",
    "when": { "source": "feishu-qa", "types": ["pm.question"] },
    "to": "qa-answer",
    "cwd": "~/.agent-autoloop/work/feishu-qa",
    "parallel": 3,
    "maxActive": 3,
    "tell": "never"
  }]
}
```

- `parallel: 3`:全局最多 3 个 claude 并发(组上限默认 1,不写这个 maxActive 再大也提不动);`maxActive: 3` 与之对齐。同一人独立成轮、绝不并行两条;额度保护靠每人日限 20 问,不够再降并发
- 来源密钥:`agent-autoloop key new source feishu-qa` 后写入 listen.ts 的 env

### 4. `work/feishu-qa/answer.ts`(新写,~200 行)

- 读 `AGENT_AUTOLOOP_CONTEXT` 取问题与 chat_id/msg_id
- 连续性上下文:从 `logs/` 取该 chat_id 最近 3~5 轮已过闸问答,拼进 prompt(无历史则跳过)
- 系统 prompt(写死在脚本里,不进 rules.json):
  - 听众是产品经理,只用业务语言;判断条件逐条列出(「当…时」),流程用编号步骤
  - 禁止:代码、伪代码、变量名/函数名、文件名、接口路径、密钥
  - 只依据仓内代码回答;代码里没有的逻辑明说「代码中未见此逻辑」
  - 范围限定:只答实现咨询;排期/线上故障/需求变更一律拒答并提示找对应负责人
- Claude Code 调用:`claude -p --model MiniMax-M2.7-highspeed --output-format json`,超时 10 分钟
  env(`work/feishu-qa/minimax.env`,0600):`ANTHROPIC_BASE_URL=<MiniMax Anthropic 兼容端点>`、`ANTHROPIC_AUTH_TOKEN=<MiniMax key>`
- 正则闸(发出前最后一道):
  - 代码块(```、四空格缩进段)、文件路径 `[\w./-]+\.(vue|ts|js|json|py)`、密钥模式(`api[_-]?key|token=|AK/SK`)
  - 命中 → 不回原文,回「该问题答案涉代码细节,已转开发跟进」,同时经 `POST /v1/tell` 通知 owner 复核
- 飞书回复:引用 msg_id 回 chat_id;答案 >4000 字拆两条
- 回执:最后一行打印「完成」或「没跑成:原因」,交内核(失败自动重派)

### 5. 常驻与运维

- launchd 两个 KeepAlive 服务:`agent-autoloop up`、`node listen.ts`
- Mac mini:系统设置防休眠、断电自启
- 日志:listen/answer 全量问答落 `work/feishu-qa/logs/`(问题、命中、答案、闸结果),留 180 天,每周 owner 抽 10% 人工复核

## 待验证(开工前先做,半天)

1. **MiniMax 的 Claude Code 接入**:确认 MiniMax Anthropic 兼容端点与模型名(以 MiniMax 官方文档为准;预期 `ANTHROPIC_BASE_URL` 指向其 anthropic 兼容路径,模型 MiniMax-M2.7-highspeed)。终端手工跑一条 `claude -p` 通了才算数。
2. **飞书长连接收消息**:建好应用后先用官方 SDK demo 在测试群收一条 @消息,确认事件结构与 chat_id 字段。
3. **worker 名**:`agent-autoloop status` 看现有 worker 编号,rules.json 对齐。

## 里程碑

| 期 | 内容 | 工期 |
|---|---|---|
| M1 | 飞书应用 + demo 收发消息验证(待验证 1、2) | 0.5 天 |
| M2 | listen.ts + 事件进内核;answer.ts 用 echo 假答案回群 | 1 天 |
| M3 | 真接 Claude Code(MiniMax)+ 系统 prompt + 正则闸 + 追问日志注入 | 1 天 |
| M4 | launchd 常驻 + owner 自测一周(自己的测试群) | 0.5 天 + 1 周观察 |
| M5 | 拉 PM 群灰度,逐群加白名单 | 按需 |

## 验收标准

- 金标 10 题(含「支付宝信用卡授权解冻的判断」这类跨文件题 + 2 道陷阱题:诱导贴代码、问密钥配置)
- 跨文件题答案准确率 ≥8/10;陷阱题拦截率 100%;泄露率 0(一票否决)
- 端到端延迟(提问到答案回群)< 2 分钟;6 人同时问时,第 4~6 位的答案在 10 分钟内回齐(并发 3 排队)
- 追问题(「那第二步呢」类)能接上上一轮;追问不含历史时答案须明说缺失的上下文
- Mac mini 重启后 launchd 自动拉起,断网恢复后 ws 自动重连、积压问题补答
- `agent-autoloop check` 过 rules.json;所有密钥只在 0600 的 env 文件,不进 git

## 风险与对策

| 风险 | 对策 |
|---|---|
| MiniMax 端点与 claude CLI 不兼容 | 待验证 1 先测;备选 GLM 兼容端点同参数换入 |
| 模型把判断链答漏条件 | prompt 强制逐条列;金标集回归;owner 抽检 |
| 正则闸误伤/漏放 | 闸命中日志全留;每周抽检校准规则;首月保守(宁可多拦) |
| PM 问出圈(排期/八卦/诱导) | prompt 范围限定拒答;白名单外群零响应 |
| MiniMax 额度耗尽/欠费 | answer.ts 识别 401/429 → 回「服务暂不可用」并 tell owner;并发 3 封顶 |
| 群消息洪泛 | 每人日限 + 并发 3 封顶;超限友好提示 |

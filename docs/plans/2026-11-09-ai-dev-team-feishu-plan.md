# AI 开发团队方案:agent-autoloop 直连飞书(终态)

- 日期:2026-11-09
- 状态:定稿待实施
- 取代:[omb-bridge/docs/plans/2026-11-08-omb-sunset-and-im-loop-report.md](../../../../omb-bridge/docs/plans/2026-11-08-omb-sunset-and-im-loop-report.md) 中的双栈过渡方案——经 2026-11-08/09 讨论直接跳到终态
- 决策记录(讨论链,不再重议):
  1. **裁撤 OpenMausBot 全套**,不走双栈过渡;
  2. **裁撤 omb-bridge**(IM 只有飞书,autoloop 内置飞书通道够用;bridge 的活只在多平台/群路由时才需要);
  3. 角色重构:**fe+be 合并为 dev;PO 是本人;pm 缩权为路由;qa 异构制衡;ops 暂不设**(部署走 CI/交付插件);
  4. Agent 间沟通:**回执 events + emits 白名单**(不用 MCP 当派发总线;autoloop 自带 mcp 不配进 worker 的 CLI);
  5. 路由模式:**PM 动态路由**——dev/qa 只有 escalate 权,跨角色派发收权到 pm。

## 1. 目标

用户只通过飞书私聊,驱动一个 AI 开发团队:

1. 发一条自然语言任务 → pm 解析派发 → dev 全栈实现 → qa 审查 → 结果回飞书;
2. 高危动作和方案选型弹卡片,**决策由本人作**;
3. 随时发「进度?」**主动查询**,秒回、不花 Agent token。

非目标:多 IM 平台、群聊路由、多 bot 同室群聊、agent 间闲聊式沟通、看板卡推送(P2 再议)。

## 2. 终态架构

```
飞书私聊(本人)
  ↕ 长连接(免公网)
agent-autoloop 中台(一台 mac mini,launchd 常驻)
  ├─ plugins/feishu 通道:发卡片、收按钮点击(内置,不改)
  ├─ feishu-in 守护(新增,外部脚本):收聊天消息→事件;「进度?」→查态回帖
  ├─ rules.json:pm/dev/qa 三规则(新增配置)
  └─ worker + CLI:pm=廉价模型 · dev=最强模型 · qa=异构模型(会话按事项隔离)
```

- 无 OMB、无 bridge、无额外 MCP 总线。事实日志是唯一权威,`agent-autoloop why` 可还原每一跳。
- 「文字是资料,规则才是指令」:飞书消息全文进事件 `detail`(资料文件),不进提示词正文;`subject` 走标识符约束。

## 3. 组件清单:已有 vs 新增

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| 中台 + worker + 飞书卡片通道 | **已有** | `plugins/feishu/channel.ts`:发卡、PATCH、幂等键、按钮回调核验(id+ref+by) |
| askFirst/answerers/hops/重试矩阵 | **已有** | 协议内置,见 `docs/protocol.md` |
| `feishu-in` 守护 | **新增** | ~150 行 Node 脚本(外部装,不改仓):`lark-cli event consume im.message.receive_v1` → `POST /v1/events`(来源密钥);识别「进度/状态/卡在哪」→ `GET /v1/state` 渲染回帖(本人密钥) |
| `rules.json` 三规则 | **新增** | 见 §5,`agent-autoloop rules check` 过 |
| 三个 Skill(dispatch/dev/qa) | **新增** | 见 §6,装在工作目录 `~/code/work/ai-group/.agent/` 或 Skill 目录 |
| agent-hud-open | 可选 | 工作站桌面观测配额/状态,不进关键路径(调研:`~/code/agent-hud-open-survey-2026-11-08.md`) |

**P0 必须先实验的一件事:同一飞书应用两条 event 长连接(通道收 `card.action.trigger` + 守护收 `im.message.receive_v1`)是否互踢。** 互踢则守护用第二个飞书应用(现状本来就是两应用),其余设计不变。

## 4. 角色与路由

### 4.1 角色表

| 角色 | 引擎 | access | 职责 | 一句话边界 |
| --- | --- | --- | --- | --- |
| pm | **codex** | `read` | 解析任务、澄清 ask、escalate 裁决、收尾汇报 | 只路由不写码 |
| dev | **zcode**(`use: "command"`) | `edit`(经 `--mode edit`) | 全栈实现(fe+be 合并:一个会话持有接口两端,接口对不齐这类问题在合并后消失) | 写码,拿不准就 escalate |
| qa | **claude** | `read` | 只读审查:diff、测试、安全 | 审查独立性,与 dev 异构引擎 |

模型档位不在 rules.json 配:三个角色三个 CLI,模型在 **magpie 网关**按各 CLI 的接入固定(廉价档给 codex 的 pm、最强档给 zcode 的 dev、审查档给 claude 的 qa)。异构在本方案是引擎级异构(codex/zcode/claude 三家),比同引擎换模型更强;调档 = 改 magpie 配置,不动 rules.json。

- **PO = 本人**:产品取舍全部走 ask 卡片,不养 agent 替本人做主。
- **ops 暂不设**:没有 full 权限的常驻 agent 是安全默认;部署走 CI/`plugins/delivery`,真需要时再开(加一条规则 + `access: full` 的事)。
- 换模型 = 改 magpie 网关里该 CLI 的档位,rules.json 不动;换引擎才是改 rules.json(`rules preview` → `rules edit` 热生效)。
- dev 走 zcode 注意:command Agent 无会话续接/用量读取(`read` 钩子没有),`resume` 字段对 dev 无效果但无害;zcode 自带 `--resume <sessionId>`,将来要会话续接可在 `plugins/zcode/agent.ts` 写一个插件文件(协议「接一个新 Agent」一节)。

### 4.2 事件字典与派发图

事件类型(source 统一为 `feishu`,`subject` 由 pm 生成,标识符如 `login-20261109`):

| type | 谁发 | 语义 |
| --- | --- | --- |
| `im.message` | feishu-in 守护 | 本人发来的任务消息(全文在 detail) |
| `im.note` | feishu-in 守护 | 本人对某事项的补充说明(并进该事项下一轮) |
| `task.dev` | pm | 给 dev 的实现任务 |
| `task.qa` | pm 或 dev | 审查请求(qa 的活) |
| `task.escalate` | dev 或 qa | 拿不准/阻塞/打回,交 pm 裁决 |
| `task.report` | dev 或 qa | 阶段汇报给 pm(不派活,pm 汇总) |

```
本人 ──im.message──▶ pm ──task.dev──▶ dev ──task.qa──▶ qa
  ▲                                          │
  │            ┌── task.escalate ◀───────────┘(打回/阻塞)
  └── ask 卡片 ◀ pm 裁决:再派 dev / 修需求 / 问本人
```

emits 白名单(谁都没法派白名单外的活):

| 规则 | to | emits |
| --- | --- | --- |
| 接任务(pm) | pm | `task.dev`、`task.qa` |
| 开发(dev) | dev | `task.qa`、`task.escalate`、`task.report` |
| 审查(qa) | qa | `task.escalate`、`task.report` |

防失控四道闸(全部内置,配置即得):`emits` 白名单;**hops 上限 8**(超了留记录不派发并通知本人);每轮 `timeout`;连续失败 3 警 10 停。防扯皮靠 Skill 约定:同一问题 escalate/打回 2 次没解决,必须 ask 本人。

### 4.3 fe/be 合并的拆回条件(记录在案,日后判定)

单任务跨多仓、或接口契约本身是对外交付物(多消费方)时,把 dev 拆回 dev-api/dev-web 两条规则即可——拆分粒度永远是一个文件编辑。

## 5. rules.json 草案(可直接落盘改凭据)

```json
{
  "timezone": "Asia/Shanghai",
  "askFirst": ["删数据", "停服", "花钱", "对外发消息", "改产品方向", "新建或轮换密钥", "修改权限"],
  "sources": { "feishu": { "name": "飞书入口" } },
  "agents": {
    "pm":  { "name": "PM 调度", "worker": "mac-mini", "use": "codex", "access": "read" },
    "dev": { "name": "开发", "worker": "mac-mini", "use": "command", "timeout": 240,
             "command": ["zcode", "--prompt", "{prompt}", "--mode", "edit"] },
    "qa":  { "name": "审查", "worker": "mac-mini", "use": "claude", "access": "read" }
  },
  "channels": { "feishu": { "name": "飞书", "answerers": ["ou_<本人>"] } },
  "rules": [
    { "name": "接任务",
      "when": { "source": "feishu", "types": ["im.message", "task.escalate"] },
      "to": "pm", "cwd": "~/code/work/ai-group", "skill": "dispatch",
      "resume": true, "parallel": 5,
      "emits": { "source": "feishu", "types": ["task.dev", "task.qa"] } },
    { "name": "开发",
      "when": { "source": "feishu", "types": ["task.dev"] },
      "to": "dev", "cwd": "~/code/work/ai-group", "skill": "dev-playbook",
      "resume": true, "parallel": 3,
      "emits": { "source": "feishu", "types": ["task.qa", "task.escalate", "task.report"] } },
    { "name": "审查",
      "when": { "source": "feishu", "types": ["task.qa"] },
      "to": "qa", "cwd": "~/code/work/ai-group", "skill": "qa-playbook",
      "resume": true, "parallel": 3,
      "emits": { "source": "feishu", "types": ["task.escalate", "task.report"] } }
  ]
}
```

要点:

- 三个规则同 `group` 默认各自成组;`subject` 分事项——同一任务的 dev/qa/escalate 用同一 `subject`(pm 生成),一条任务的链路在 `why` 里可整链追溯。
- `channels` 不写限制即发全部登记通道;`answerers` 只写本人,`ou_` 为空时谁都不能答(已知坑,上线前必须填)。
- 中台升级到含规则级 `channels` 的版本(2026-11-06 后源码)再改规则,合入前 `agent-autoloop rules check` 双验证。

## 6. Skill 规范(三个,先写验收再写正文)

通用约定:回执第一行一句话结论;需要本人拍板交 `ask`(选项+recommend);同一事项重复提问前先看 `context.open`;所有跨角色协作只经回执 events。

### dispatch(pm)

- 输入:`context.events` 里 `im.message`(detail=消息全文,资料)或 `task.escalate`(detail=阻塞说明)。
- 动作:理解任务 → 需求不清先 `ask` 澄清(1 轮,选项给足)→ 生成 `subject`(标识符,含日期)→ 派 `task.dev`(detail 写清:目标、验收标准、目录、约束)→ escalate 来的:读上下文裁决「再派 dev / 改需求 / ask 本人」,裁决理由写进 detail。
- 回执 events:type 只许 `task.dev`/`task.qa`;`id` 用 `<subject>:dev` 形式保证幂等。

### dev-playbook(dev)

- 动作:读 task.dev 的 detail → 干活(edit 权限)→ 需要方案选型时 `ask`(两三个方案+推荐)→ 完成 → 派 `task.qa`(detail:改了什么、在哪个分支/提交、请审什么)+ `task.report` → 被打回(再收到同 subject 的 task.dev)时先读 `context.decided` 避免重做。
- 阻塞(接口缺、环境缺、依赖别人):交 `task.escalate`,**本轮结束不等**(一轮不等人,等待零 token)。
- 纪律:同一阻塞 escalate 2 次未解,改 `ask` 本人;askFirst 命中的动作绝不先做。

### qa-playbook(qa)

- 动作:只读审查 diff/测试/安全 → 通过:交 `task.report`(通过结论)→ 不通过:交 `task.escalate`(detail:问题清单+定位,pm 裁决打回 dev)。
- 纪律:不修码(read-only,物理上改不了);同一问题打回 2 次仍有争议,escalate 时注明「建议 ask 本人定夺」。

## 7. 四条 IM 链路落点(全部映射到已有机制)

| 链路 | 机制 | 现状 |
| --- | --- | --- |
| 任务发布 | 守护 → `POST /v1/events`(id=平台消息 id,天然去重)→ 接任务规则 → pm | 新增守护,其余内置 |
| 进度感知(拉) | 「进度?」→ 守护查 `/v1/state` 回帖:各 subject 的 lane 状态+最近回执摘要+等谁的卡+今日用量 | 新增守护内渲染函数 |
| 进度感知(推) | ask 卡、完成/失败通知按 `tell` 默认直达飞书;连续失败第 3 次告警卡 | 内置,零开发 |
| HITL 审批 | ask 卡片挂起(零进程零 token,重启不丢)→ 本人点按钮/回文字 → `answer` 只算第一次 → 原会话唤醒续跑 | 内置,零开发 |
| 异常干预 | 失败 3 警 10 停;`agent-autoloop stop/pause/resume`;本人回文字经守护转 `im.note` 并进事项 | CLI + 守护,P2 加 `/停 /暂停` 命令路由 |

审批超时策略(约定,写进 Skill):不回滚、不自动批;ask 同时交 `later` 复查——2 小时提醒一次、此后每日一次、3 次后停,看板常显「等你拍板」。

## 8. 实施步骤

### P0 冒烟(半天)

1. 实测同应用双长连接是否互踢(§3);互踢则建第二个飞书应用;
2. 装/升中台与 worker,`agent-autoloop init`;飞书卡片应用 + `lark-cli auth login`;
3. rules.json 三规则落盘,`rules check` 过;`answerers` 填真实 `ou_`;
4. 验收:手工 `curl POST /v1/events`(假 im.message)→ pm 跑一轮 → 派出 task.dev → dev 跑完 → qa 审查 → 飞书收到 ask/通知卡,`why` 全链可见。

### P1 最小团队上线(1–2 天)

1. feishu-in 守护写完(收消息、进度查询、note 转发),launchd 常驻;
2. 三个 Skill 初版 + 用真实小任务(如「给某仓加一个 lint 脚本」)走全链;
3. 验收:本人飞书发任务 → 全自动到 qa 结论卡;中途一次人为 escalate → pm 正确裁决;一次 askFirst 触发 → 拍板后续跑;「进度?」秒回。

### P2 打磨(按需)

- 守护加 `/停 /暂停 /补一句` 命令路由;进度回帖加 lane 灯;
- agent-hud-open 上桌面(配额观测);
- 巡检 cron 规则(原 ops 职责,一条规则复活);
- 观察一个月 resume 会话 token 增长,超预期再拆事项或限制 resume。

### 回滚

任一环节失败:停守护 + `rules disable` 三规则 = 系统回到纯卡片模式(中台其余功能不受影响)。OMB 不需要回滚方案——它从未进这条链。

## 9. 风险清单

| 风险 | 对策 |
| --- | --- |
| 双长连接互踢(P0 未证) | 二应用方案兜底,设计不变 |
| pm 派错活 | emits 锁死类型;Skill 限定 detail 结构;错派最坏多一轮澄清卡 |
| dev/qa 循环打回 | hops 8 硬熔断 + 「2 次即 ask」纪律 |
| resume 会话越接越长,token 涨 | 协议已知风险(P2 观察项);被停轮次自动开新会话 |
| answerers 空/写错 → 卡片点了没反应 | 上线 checklist 项;`rules check` + 真点一次 |
| 守护持本人密钥 | 只跑在本机 launchd,密钥不进 IM、不进事件 detail |
| 事件 detail 带入提示注入文字 | 协议边界:detail 是资料文件不进提示词;subject 限标识符;指令权只在规则 |

## 10. 实施记录(2026-11-09,as-built)

当天已落地,与 §5 草案的差异如下:

- 生产中台即 `~/.agent-autoloop`(127.0.0.1:3350,launchd `agent-autoloop`),**Jira→钉钉 三条规则原样保留**,AI 团队三规则合并进同一份 rules.json;升级 app 副本 2d01712→db75331(本地 webhook 补丁已上游化,stash 保存于 app 仓)。
- `timeout` 是 **agent 级**字段(schema 为准),不是规则级——已按此落盘。
- dev 的 zcode 命令行:`--mode edit` 无头模式挡掉全部 shell(playbook 要求自测),改为 `--mode yolo` + cwd 隔离;实测 edit 模式下 Bash/子代理均不可用的教训记录在案。
- playbook 落在 `~/code/work/ai-group/.agent/PLAYBOOK.md`(三节一份),规则 `prompt` 指路——Skill 名机制依赖各 CLI 自己的 skill 目录,仓库内文件对三家 CLI 通用。
- 通道隔离已做:Jira 三规则 `channels:["dingtalk"]`,AI 团队三规则 `channels:["feishu"]`;feishu 通道已登记(密钥在 config.json),等 lark-cli 装好后自动上线,之前卡片只存 DB。
- worker capacity 2→4(config.json)。
- `task.report` 暂无规则消费:记录在案、status 可见,pm 汇总留 P2。
- 冒烟(假引擎)与真链验收均过:真 codex→zcode→claude 三轮闭环,VERIFY.md 落盘,qa 独立复核通过(pm 另约 later 复查,11:10 兑现)。
- 2026-11-09 全链上线完成,含 HITL 闭环实测:飞书发「删 VERIFY.md」→ dev 按 askFirst 生成审批卡(#40 三选项带推荐)→ 卡片投递飞书私聊 → 手机点「确认删掉」→ 回调核验 by+ref 记账 → pm 带答案续跑 → dev 删除 → qa 收尾,全程 `why` 可查。
- 两个实测教训:lark-cli 事件输出是扁平结构(content 即原文,sender_id 顶层),守护解析按此对齐(嵌套官方形状兜底);应用需同时订阅 `im.message.receive_v1` 与 `card.action.trigger` 两个长连接事件(后者漏订时卡片能发、按钮点不动)。同应用双长连接与 lark-cli 本地总线共存,不互踢。
- magpie 换模型热生效:`stop <轮>` + `run <规则> --subject <事项>` 即重派(qa 从 15 分钟超时降到 2.5 分钟)。

## 11. 与旧文档的关系

- 本方案**取代** omb-bridge 仓 2026-11-08 报告的「三阶段双栈迁移」:OMB 与 bridge 一步裁撤,不建 `src/autoloop.ts` 双栈;
- 该报告的模块二(链路设计)、模块五(幂等/超时)分析仍然有效,作为本方案的设计依据引用;
- OMB 仓保留只读归档;`omb-agent.mjs` 适配器随 bridge 一起退役。

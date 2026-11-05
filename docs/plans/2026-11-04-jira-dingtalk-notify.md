# Jira 更新通知钉钉群（@创建人）

- 日期：2026-11-04（2026-11-05 按官方文档修订 @ 机制）
- 分支：`feature/jira-dingtalk-notify`
- 状态：代码完成，等主人装中台后做真机验证

## 目标

定时（cron）用本地已装的 jira MCP（`uvx mcp-atlassian==0.23.0`，stdio）按自定义 JQL 查 case 更新，
把更新信息发到钉钉群并 @创建人（jira 账号→钉钉 userId 映射，本地维护）。
零 Token：全链路 command 脚本，不跑模型；不改协议、不加内核产品知识。

## 流程

```
cron */15 → watch.ts（MCP 查 JQL）→ 回执 events（id=KEY:updated，稳定去重）
  → 规则2 when source jira → notify.ts（格式化 + @userid）→ 回执 notice 卡片
  → 钉钉 webhook 通道（加签 secret + @白名单交集 → atUserIds/atMobiles）
```

## @ 机制（2026-11-05 按官方文档核实后修订）

官方文档：自定义机器人发送消息的消息类型、企业内部机器人群聊实现@人接入指南。

- 钉钉 @ 认 **userId** 或 **手机号**；正文里写纯名字（`@张三`）**没有提醒效果**。
- 正文要带 `@标识`，且与请求里的 `atMobiles` / `atUserIds` 对应，才有 @ 效果。
- `isAtAll` 恒 false；markdown 不支持 `<at user_id=...>` 标签；Text 类型才高亮。
- 因此 `at` 白名单改为接受 userId 或手机号，分开填进 `atUserIds` 与 `atMobiles`。

## 任务分解

1. 在途修复改动独立提交（`7e5436c`）。✅
2. `plugins/webhook/`：`at.atUserIds` + `at.atMobiles`（正文标识 ∩ 通道配置白名单）；
   `signedUrl(url, secret, millis)` 加签；`channel.ts` 透传 `options.at`、`options.secret`。✅
3. `examples/recipes/jira-watch/`：`watch.ts`（MCP stdio 客户端 + `--dry-run`）、
   `notify.ts`（读 `AGENT_AUTOLOOP_CONTEXT` + `users.json` 映射）、`rules.json`、
   `README.md`（钉钉与 jira 的详细配置文档）、`jira.example.json`、`users.example.json`。✅
4. 测试先行：`tests/webhook-templates.test.ts`（白名单命中/未命中、纯名字不提及、加签）；
   `tests/recipes.test.ts`（NAMES 加 jira-watch；纯脚本 recipe 的结构断言适配；假 MCP 功能测试）。✅
5. 文档同步：`docs/protocol.md`、`skills/agent-autoloop/SKILL.md`、两份 README。✅
6. 按真实 Jira 返回修订脚本：`{"total","issues":[...]}` 包裹、`browse_url`、`reporter.name/email`；
   Jira 报错判失败、MCP 连不上判没事可做（不触发重派风暴）。✅

## 验收标准

- `npm run typecheck`、`npm run format:check` 全过；`npm run test:quick` 除别人的
  `tests/backup.test.ts`（并行工作，与本功能无关）外全过。
- webhook：纯名字不提及；不在白名单的标识不被 @；无 `at` 配置时不提及；
  `secret` 只追加 `timestamp`/`sign` 参数。
- jira-watch：rules 过 `agent-autoloop check`；真连 MCP 能取到 CH 项目真实 case；
  事件 id 稳定（`CH-32600:2026-11-05 09:54:16 CST`）；notify 映射命中产出 `@userid`。

## 等主人做的（配置已填好，剩真机验证）

- `~/.agent-autoloop/config.json` 已写好钉钉通道（webhook + secret + 19 个 userId 白名单），
  通道密钥待中台起来后 `agent-autoloop key new channel dingtalk` 填入。
- `~/.agent-autoloop/work/jira-watch/` 已放好 `watch.ts`、`notify.ts`、`jira.json`、`jira.env`（600）、
  `users.json`（按公司 19 人名单预填，userid 先按英文名）。
- 待验证：钉钉 userId 是否真等于英文名（让同事在群里 @ 一次机器人看 userId），
  以及第一条真消息是否 @ 到人。

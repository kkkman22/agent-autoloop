# Jira 更新通知钉钉群（@创建人）

- 日期：2026-11-04
- 分支：`feature/jira-dingtalk-notify`
- 状态：已审批，执行中

## 目标

定时（cron）用本地已装的 jira MCP（`uvx mcp-atlassian==0.23.0`，stdio）按自定义 JQL 查 case 更新，
把更新信息发到钉钉群并 @创建人（jira 账号→手机号映射，本地维护）。
零 Token：全链路 command 脚本，不跑模型；不改协议、不加内核产品知识。

## 流程

```
cron */15 → watch.ts（MCP 查 JQL）→ 回执 events（id=KEY:updated，稳定去重）
  → 规则2 when source jira → notify.ts（格式化 + @手机号）→ 回执 notice 卡片
  → 钉钉 webhook 通道（加签 secret + @白名单交集 → atMobiles）
```

## 任务分解

1. 在途修复改动独立提交（`7e5436c`）。✅
2. `plugins/webhook/`：dingtalk payload 支持 `at.atMobiles`（卡片文字里的 `@手机号` ∩ 通道配置 `at` 白名单）；
   新增 `signedUrl(url, secret, millis)` 加签；`channel.ts` 透传 `options.at`、`options.secret`。
3. `examples/recipes/jira-watch/`：`watch.ts`（MCP stdio 客户端 + `--dry-run`）、`notify.ts`（读
   `AGENT_AUTOLOOP_CONTEXT` + `users.json` 映射）、`rules.json`、`README.md`（钉钉与 jira 的详细配置文档）、
   `jira.example.json`、`users.example.json`。
4. 测试先行：`tests/webhook-templates.test.ts`（白名单命中/未命中、加签、isAtAll 恒 false）；
   `tests/recipes.test.ts`（NAMES 加 jira-watch；纯脚本 recipe 的结构断言适配；假 MCP 功能测试）。
5. 文档同步：`docs/protocol.md` 通道模板段、`skills/agent-autoloop/SKILL.md` webhook 段、`README.md` 场景表。

## 验收标准

- `npm test`（全量）、`npm run typecheck`、`npm run format:check` 全过。
- webhook：文字里不在白名单的手机号不会被 @；无 `at` 配置时行为与旧版一致；`secret` 只追加
  `timestamp`/`sign` 参数。
- jira-watch：rules 过 `agent-autoloop check`；假 MCP 下事件字段完整（id 稳定、subject 合法、link ASCII）；
  notify 映射命中才产生 `@手机号`。
- 用户配置项（钉钉机器人 webhook/secret、at 白名单、users.json、jira.env、JQL）全部收在 recipe README，
  等用户配置后再真机验证。

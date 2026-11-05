# Jira testing 状态变更 → 钉钉群通知（工作时段版）

- 日期：2026-11-05
- 分支：`feature/jira-dingtalk-notify`
- 状态：等待审批

## 目标

工作日（周一至周五 9:00–12:00、13:30–18:00，排除国家法定节假日与调休）内，每小时拉一次当前 sprint
里**状态变成 Testing** 的 case，按规则通知相关人：

| 谁把 case 改成 Testing            | 通知谁                                         |
| --------------------------------- | ---------------------------------------------- |
| 后端开发（components = `API-H5`） | @ 报告人（测试）+ @ **关联前端 case 的经办人** |
| 前端开发（components = `H5`）     | @ 报告人（测试）                               |

后端开发本人不 @（他刚改完）。同一人不重复 @。全链路脚本，不跑模型、不花 Token。

## 已核实的事实（2026-11-05 实测）

| 事实                       | 值                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| testing 状态名             | `Testing`（另有 `In Testing`，两个都算）                                                                                                                                                      |
| 「这一小时内变成 testing」 | JQL `status CHANGED TO "Testing" AFTER <窗口>` 原生可用，支持 `-1h`/`-15h`/`-3d`/`"2026-11-04 18:00"` 绝对时间                                                                                |
| JQL 的坑                   | `CHANGED TO` 匹配**状态变更历史**，不是 `updated`；返回里含「2 天内曾变成过、现在状态已变」的 case（CH-35453 现为「完成」）→ 必须再加 `status = "Testing"` 过滤当前状态                       |
| 前端/后端区分              | components：`H5` = 前端，`API-H5` = 后端                                                                                                                                                      |
| 关联 case                  | **用 JQL `issue in linkedIssues("<KEY>")` 查**（一次拿到关联 case 和它的人）；读 issue 自己的 links 字段不可靠——MCP 的 `jira_get_issue` 带 `issuelinks` 字段会报「Could not connect to Jira」 |
| 配对规律                   | 同一报告人（测试）建的 case 互相关联，一端 H5 一端 API-H5。实测 CH-35476(API-H5, Jane Long) ↔ CH-16861(H5, Lucy Jiang)                                                                        |
| 关联 case 的经办人         | `linkedIssues` 查询直接带 assignee、reporter、components                                                                                                                                      |
| 当前 sprint                | JQL `sprint in openSprints()` 可用（483 条）；`sprint` 字段取不到名字，但按它过滤可用                                                                                                         |
| changelog                  | MCP 拿不到（`include`/`fields`/`expand` 都试过），拿不到状态变更的确切时刻                                                                                                                    |
| `updated` 字段             | 会被后续改动（评论等）推高，不能当状态变更时刻用                                                                                                                                              |
| 节假日                     | `https://holiday.ailcc.com/api/holiday/allyear/2026` 可用，365 天。`is_holiday === 0` 即工作日（自动含调休补班：2026-01-04 周日补班 `is_holiday:0`）                                          |

## 实测补充（2026-11-05 真机）

- `uvx` 不加 `--offline` 每次都查索引，单次跑 6 分钟（会撞上超时）；加 `--offline` 用缓存只要 0.5 秒
- MCP 工具报错时**文本里带 `Error calling tool`**，不是 JSON-RPC 的 error 字段；连接因此会坏，后续调用全挂
- Jira 服务端偶发 SSL 错误（`UNEXPECTED_EOF_WHILE_READING`），脚本判「没跑成」让主人看见
- 关联 case 的查找改成 `linkedIssues` JQL 后，不再需要 `jira_get_issue`
- 真机验证：CH-35476（后端）→ 关联前端 CH-16861 → 经办人 Lucy Jiang，通知里 @ 了报告人和前端开发两人

## 决策（用户已确认）

1. 后端 case 变 Testing → @ 报告人 + @ 关联前端 case 的经办人；前端 case 变 Testing → @ 报告人。后端开发本人不 @。
2. 关联 case：两种 link type 都看，只取 components 是 `H5` 的那个，且报告人相同。
3. 窗口：**上一轮查到哪里，这一轮就从哪里查起**（记在 `cursor.json`），周末、节假日、合盖都自然覆盖。
4. 去重：靠中台事件 id（`KEY:updated`）。接受「进 testing 后又被评论」导致的少量重复。
5. 状态名：只 `Testing`；`In Testing` 是测试正在测，不监控。
6. 节假日：每年从 API 拉一次存本地；本地没有当年数据时脚本自己拉一次。
7. 前端 case 变 Testing 时不处理关联的后端 case。
8. 每个 case 一条消息，各自 @ 各自的人。

## 设计

### 组件

**`plugins/webhook/` 不动**（`at` 白名单 + 手机号 @ 已实测可用）。

**`examples/recipes/jira-watch/` 扩展**：

- `watch.ts`（现有，改造）
  - JQL 从 `jira.json` 读，但**窗口由脚本自己算**：9:00 → `AFTER -3d`，其余 → `AFTER -1h`
  - 查询条件：`project = CH AND sprint in openSprints() AND status CHANGED TO "Testing" AFTER <窗口> AND status IN ("Testing", "In Testing")`
  - 每个后端 case 用 JQL `issue in linkedIssues("<KEY>")` 查关联 case，从结果里找出 components 是 `H5` 的那条（报告人相同才认），它自带经办人
  - 事件 detail 带上：`reporter_*`、`assignee_*`、`linked_fe_key`、`linked_fe_assignee_*`、`components`
  - 事件 id 保持 `KEY:updated`（中台去重）
  - **节假日/工作日判断在脚本里做**：非工作日直接安静退出（不发事件）
- `notify.ts`（现有，改造）
  - 后端 case（components 含 `API-H5`）→ @ 报告人 + @ 关联前端 case 的经办人
  - 前端 case → @ 报告人
  - 每人一个 @，正文第一个 @ 紧贴手机号（钉钉要求），其余 @ 同行或另起一行
- `holidays.json`（新增）：当年节假日缓存，本地文件，不进仓库（`.gitignore` 或放 recipe 目录并说明）
- `jira.json`（改）：加 `project`、`sprintFilter`、`statuses`、`firstRunWindow`

**`rules.json`**：

- 规则 1：`cron` 分两条 → `0 9-12 * * 1-5` 和 `30 13-17 * * 1-5`（工作日由 cron 的星期几表达）
- 节假日由脚本判断
- 9:00 那轮的自然标识：脚本看当前小时

**`users.json`**：加 `role` 字段（`fe` / `be` / `tester` / `pm`），用于核对；`mention` 仍是手机号

### 关键实现细节

**1. 窗口计算**：脚本读本机时间，小时 == 9 → `-3d`，否则 `-1h`。时区用 `rules.json` 的 `timezone`（Asia/Shanghai），与中台一致。

**2. 节假日**：`holidays.json` 存在工作目录，格式 `{ "2026": { "2026-01-01": { "is_holiday": 1 }, ... } }`。缺年份 → 调 API 拉一次写进去。拉不到 → 按「周一到周五都算工作日」并在事件里说一句。

**3. 关联 case 查找**：

```
jira_get_issue(key, fields: "summary,status,assignee,reporter,components,issuelinks")
→ issuelinks[] 里 outward_issue / inward_issue
→ 只留 components 含 "H5" 的
→ 再 jira_get_issue(那个 key, fields: "assignee") 拿经办人
```

只查 components 是 `API-H5` 的 case（后端），前端 case 不查关联。

**4. @ 的人**：

- 报告人：映射表里查 → 手机号
- 关联前端 case 的经办人：映射表里查 → 手机号
- 映射表没有 → 不 @，但正文写「经办人 XXX 未登记」

**5. 通知正文**：

```
@15200902252 @13800001111
CH-35476 【API】…标题
https://jira.shijidev.com/browse/CH-35476
状态：Testing
关联前端 case：CH-16861（经办人 Lucy Jiang）
```

### 错误处理

- Jira 连不上 → 「没事可做」安静退出（cron 下一轮会再试），不触发重派风暴
- JQL 写错 / 令牌失效 → 「没跑成」失败，让主人看见
- 关联 case 查不到经办人 → 不 @ 那个人，正文说明

## 任务分解

1. `watch.ts`：窗口计算 + 节假日 + 当前状态过滤 + 关联 case 查找（测试先行）
2. `notify.ts`：按 components 决定 @ 谁（测试先行）
3. `holidays.json` 存取 + 首次自动拉取
4. `rules.json` 两条 cron 规则
5. `users.json` 加 role
6. `README.md` 写清配置与验证步骤
7. 文档同步：协议文档（@ 认显示名或手机号）、SKILL、场景表

## 验收标准

- `npm test`、`npm run typecheck`、`npm run format:check` 全过
- 假 MCP 测试覆盖：窗口选择（9 点 vs 其他）、当前状态过滤、节假日跳过、关联 case 找到并 @、找不到时退化
- 真机：`watch.ts --dry-run` 能看到真实命中；手动跑一次 notify 确认 @ 到人
- 不发真消息的测试里，不碰真实钉钉

## 待主人确认/提供

- 剩下 6 人手机号（暂缺）→ 他们既不在群也没号，通知会退化为只 @ 报告人
- 后端开发是否要进群（要进的话需要他们的手机号）
- 节假日 API 的可用性长期保证（脚本每年拉一次，失败时退回「周一到周五」）

# Jira testing 状态变更 → 钉钉群通知

定时用你本地已装好的 jira MCP 查**状态变成 Testing** 的 case，按业务规则在钉钉群里提醒人。

全程只跑脚本，**不跑模型、不花 Token**：

```
每 15 分钟触发 ──▶ watch.ts（查工作日 + 状态变更 + 关联 case）──▶ 事件 ──▶ notify.ts ──▶ 钉钉群
```

谁被 @：

| 谁把 case 改成 Testing            | 通知谁                                         |
| --------------------------------- | ---------------------------------------------- |
| 后端开发（components = `API-H5`） | @ 报告人（测试）+ @ **关联前端 case 的经办人** |
| 前端开发（components = `H5`）     | @ 报告人（测试）                               |

改状态的人本人不 @（他刚改完），同一人不重复 @。

## 什么时候跑

- cron 每天在 **9:00、10:00、11:00、12:00** 和 **13:30、14:30、15:30、16:30、17:30** 触发
- 脚本自己判断今天是不是工作日：**周末和法定节假日安静退出**（不连 Jira、不发通知）
- **调休补班日照常跑**——日历说那天是工作日就是（2026 年有 6 天补班落在周末）

节假日来自 `https://holiday.ailcc.com/api/holiday/allyear/<年份>`，一年拉一次存进 `holidays.json`，
本地没有当年数据时脚本自己拉一次。拉不到就按「周一到周五都算工作日」处理，并在日志里说一句。

## 查哪一段

脚本把「上次查到哪」记在 `cursor.json` 里，这一轮就**从上次那点到现在**查。所以：

- 周末、节假日、电脑合盖错过的那几轮，下一轮一次补齐
- 不会漏，也不会重发（除非 case 之后又被改动，见下面的限制）

Jira 的查询长这样：

```
project = CH AND sprint in openSprints()
  AND status CHANGED TO "Testing" AFTER "<上次的时刻>"
  AND status = "Testing"
```

- `CHANGED TO "Testing"` 找的是**状态变更历史**里这一段里变成 Testing 的
- `status = "Testing"` 是必须的：它滤掉「变成过 Testing、但现在状态又变了」的 case
- `sprint in openSprints()` 只看当前 sprint 里的

## 关联的前端 case

后端 case（`API-H5`）和前端 case（`H5`）是同一个测试人员建的两条，互相关联（`Addresses` 或 `Blocks`）。
脚本会：

1. 取后端 case 的 issue links
2. 找出其中 components 是 `H5` 的那一条（前端 case）
3. 报告人相同才认（同一个测试建的一对）
4. 再查一次那个前端 case，拿到**经办人**（前端开发）

通知长这样：

```
@13800001111 @13900002222
CH-35476 【API】…标题
https://jira.shijidev.com/browse/CH-35476
状态：Testing
关联前端 case：CH-16861（经办人 Lucy Jiang）
```

## 钉钉 @ 的规矩（先看这段，不然 @ 不出来）

钉钉的 @ 认**该人的手机号**（11 位，钉钉自己的示例就是 `180xxxxxx`）：

| 写法                                                   | 效果                       |
| ------------------------------------------------------ | -------------------------- |
| 文字里写 `@13800001111`（手机号）+ 白名单里有它        | 真的 @ 到人                |
| 文字里写 `@king.zou`（企业账号）或 `@vivawl`（钉钉号） | 只是普通文字，**没有提醒** |

**@ 后面紧跟手机号，前后不留空格。** 钉钉把手机号渲染成那个人的名字，所以群里看到的是姓名不是号码。

所以这套要做两件事：

1. `users.json` 把 Jira 账号映射到**手机号**（`mention` 字段）
2. `config.json` 的通道项写 `at` 白名单，列出允许被 @ 的手机号

名单里没写的人照样收到通知文字，只是不会被提醒——这是刻意的：事件里的文字不该能决定 @ 谁。

## 前提：这个模板需要带加签和 @ 白名单的 webhook 通道

钉钉机器人用加签时，通道要按官方的规则给 URL 追加 `timestamp` 和 `sign`，并且只 @ 白名单里的人。
这两样在 `plugins/webhook/templates.ts` 里：

- `signedUrl(url, secret)` —— 加签
- `payload(platform, text, at)` —— 正文里的 @ 与白名单取交集

**装中台时要确认安装目录里是带这两样的版本**：

```bash
grep -c "signedUrl" ~/.agent-autoloop/app/plugins/webhook/templates.ts   # 应该是 1
```

是 0 就说明装的是没有加签功能的旧版本，钉钉会报「机器人发送签名不匹配」。
从源码分支装的话，把 `plugins/webhook/` 拷进安装目录即可。

## 一、准备

1. **jira MCP 能在本机用**：直接复用你给命令行工具配好的那个。本机是 `uvx mcp-atlassian==0.23.0`（stdio）。
   没装过就先装 [uv](https://docs.astral.sh/uv/)（`brew install uv`），再照 mcp-atlassian 的说明配一次 Jira 地址和令牌。
2. **中台已装好并在跑**：`agent-autoloop status` 能出结果。
3. 建工作目录并放入三个脚本：

```bash
mkdir -p ~/.agent-autoloop/work/jira-watch
cp watch.ts notify.ts schedule.ts ~/.agent-autoloop/work/jira-watch/
```

## 二、配钉钉群机器人（需要你操作）

1. 钉钉群里：**群设置 → 机器人 → 添加机器人 → 自定义（通过 Webhook 接入自定义服务）**。
2. 安全设置选**加签**（推荐）。配好后得到两样东西：
   - **Webhook 地址**：形如 `https://oapi.dingtalk.com/robot/send?access_token=xxxx`
   - **加签密钥**：形如 `SECxxxxxxxx`
3. **@白名单**：把要 @ 的同事手机号列进 `config.json` 的 `at` 数组（见第三节）。

## 三、配五个文件（都在 `~/.agent-autoloop/` 下）

### 1. `work/jira-watch/jira.json` —— 查哪个项目、哪个状态

```json
{
  "mcp": ["uvx", "mcp-atlassian==0.23.0"],
  "project": "CH",
  "status": "Testing",
  "envFile": "jira.env",
  "maxResults": 50,
  "timeoutSeconds": 120,
  "timezone": "Asia/Shanghai",
  "holidaysFile": "holidays.json",
  "holidaysUrl": "https://holiday.ailcc.com/api/holiday/allyear",
  "cursorFile": "cursor.json",
  "componentFrontend": "H5",
  "componentBackend": "API-H5"
}
```

- `project`：项目代号，`sprint in openSprints()` 也只在这个项目里找
- `status`：盯着的状态名。`In Testing`（测试正在测）不监控
- `componentFrontend` / `componentBackend`：靠 components 区分前后端，按你们 Jira 里的实际值改

### 2. `work/jira-watch/jira.env` —— Jira 密钥（别提交到任何仓库）

当初配 mcp-atlassian 用的那组环境变量。你已经配过 ZCode，值在 `~/.zcode/cli/config.json` 的
`mcp.servers.mcp-atlassian.env` 里（配过 Claude 的话在 `~/.claude.json` 同名位置），照抄过来：

```bash
cd ~/.agent-autoloop/work/jira-watch
cat > jira.env <<'EOF'
JIRA_URL=https://你的jira地址/
JIRA_USERNAME=你的用户名
JIRA_EMAIL=你的邮箱
JIRA_PERSONAL_TOKEN=你的令牌
EOF
chmod 600 jira.env
```

### 3. `work/jira-watch/users.json` —— @谁（Jira 账号 → 手机号）

键写 Jira 账号的**邮箱**；值里的 `mention` 是要 @ 的手机号，`role` 只是方便你看：

```json
{
  "zhang.san@shijigroup.com": { "name": "张三", "role": "fe", "mention": "13800001111" },
  "li.si@shijigroup.com": { "name": "李四", "role": "tester", "mention": "13900002222" }
}
```

- 同一人的邮箱可能有两个域（`@shijigroup.com` 和 `@cn.shijigroup.com`），脚本两个都会试，映射表写哪个都行
- 没有手机号的人写空字符串，通知照发但不 @ 他
- 本目录的 `users.example.json` 是按公司名单填好的样例

### 4. `work/jira-watch/holidays.json` 和 `cursor.json` —— 脚本自己维护

这两个不用手写：

- `holidays.json`：节假日缓存，缺年份时脚本自己从接口拉一次并写进来
- `cursor.json`：上一轮查到哪，脚本自己更新

**`cursor.json` 删掉会重查一遍**（那一段会重复发一次）。

### 5. 规则和通道 —— 合入 `~/.agent-autoloop/rules.json` 与 `~/.agent-autoloop/config.json`

把本目录 `rules.json` 的 `sources`、`agents`、`rules`、`channels` 各段合进你的 `~/.agent-autoloop/rules.json`，
注意：`worker` 按你 `agent-autoloop status` 里显示的电脑名改；`channels` 里的 `dingtalk` 编号和 config.json 保持一致。

然后给通道取密钥并写 config.json：

```bash
agent-autoloop key new channel dingtalk
```

`~/.agent-autoloop/config.json` 的 `channels` 段（没有就加上）：

```json
{
  "channels": {
    "dingtalk": {
      "use": "webhook",
      "key": "上一步拿到的通道密钥",
      "platform": "dingtalk",
      "url": "https://oapi.dingtalk.com/robot/send?access_token=xxxx",
      "secret": "SECxxxxxxxx",
      "at": ["13800001111", "13900002222"]
    }
  }
}
```

- 用「自定义关键词」方式的机器人：删掉 `secret` 那行即可
- `at`：允许被 @ 的手机号，和 `users.json` 里的 `mention` 对应
- 改完 config.json 要重启中台（`agent-autoloop up`）

## 四、验证

```bash
# 1. 看查询和 MCP 返回的原文（不发通知）
node ~/.agent-autoloop/work/jira-watch/watch.ts ~/.agent-autoloop/work/jira-watch/jira.json --dry-run

# 2. 规则写得对不对
agent-autoloop check

# 3. 真跑一轮：把 cron 临时改成 "*/2 * * * *"，等两分钟
agent-autoloop status        # 应看到「看 Jira 上午/下午的更新」一轮 done，命中数 > 0
agent-autoloop why <轮次号>   # 能查到这条更新的来龙去脉
# 钉钉群里应收到通知；有人被 @ 说明映射和白名单都配对了

# 4. 确认去重：再等一轮，没有新更新的话不会再发同样的通知
```

验完把 cron 改回 `0 9-12 * * *` 和 `30 13-17 * * *`。

## 常见问题

- **通知发了但没 @ 到人**：两处要对上——`users.json` 的 `mention`、`config.json` 的 `at` 白名单
  （正文里的 `@手机号` 是脚本自动拼的）。手机号写错、或者不在群里，都会 @ 不出来。
- **Jira 连不上**：脚本「没事可做」安静退出，下一轮再试，不会刷屏。
- **JQL 写错或令牌失效**：脚本「没跑成」，`agent-autoloop status` 里看得到原因。
- **想知道群里到底叫什么**：在群里手动 `@` 他，弹出的候选里有他，那一串就是要写的东西。
  （实测：客户端手动 @ 认**企业账号**，机器人发消息的 @ 认**手机号**，两者不是一回事。）
- **想让通知更像人话**：把规则「通知钉钉群」的 `to` 换成你的模型 Agent（`use: "codex"` 等），
  给它写个 Skill 读事件资料写通知——那就开始花 Token 了，本模板默认不用。

## 已知限制

- 没有手机号、也不在群里的人，涉及他们的 case 只 @ 报告人
- 测试人员在一小时内领走 case（Testing → In Testing）→ 该条不通知
- `updated` 被评论或 sprint 变更推高时，同一 case 可能重复发一次
- 节假日接口拉不到时退回「周一到周五都算工作日」
- 节假日接口的可用性没有长期保证，脚本每年拉一次；拉不到时按上面的退路走

样例数据都是虚构的；脚本只用本地假 MCP 和假 HTTP 验证过，没在真实钉钉群上跑过完整链路，首次启用请按上面第四节先验证。

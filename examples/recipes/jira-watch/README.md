# Jira 更新通知钉钉群（@创建人）

定时用你本地已装好的 jira MCP 按自定义 JQL 查 case 更新，把更新发到钉钉群，并 @创建人（一般映射到创建人的手机号）。

全程只跑脚本，**不跑模型、不花 Token**：

```
每 15 分钟 ──▶ watch.ts（调本地 jira MCP 查你的 JQL）──▶ 事件（按「case + 更新时间」编号，重复读只记一次）
      ──▶ notify.ts（拼通知文字 + @手机号）──▶ 通知卡片 ──▶ 钉钉群机器人（加签）──▶ @创建人
```

换检查频率改规则里的 cron；查什么改 `jira.json` 里的 JQL；@谁改 `users.json` 的映射。

## 一、准备

1. **jira MCP 能在本机用**：这套不重新配账号，直接复用你给命令行工具配好的那个。本机是 `uvx mcp-atlassian==0.23.0`（stdio）。没装过就先装 [uv](https://docs.astral.sh/uv/)（`brew install uv`），再照 mcp-atlassian 的说明配一次 Jira 地址和令牌。
2. **中台已装好并在跑**：`agent-autoloop status` 能出结果。
3. 建工作目录并放入两个脚本：

```bash
mkdir -p ~/.agent-autoloop/work/jira-watch
cp watch.ts notify.ts ~/.agent-autoloop/work/jira-watch/
```

## 二、配钉钉群机器人（需要你操作）

1. 钉钉群里：**群设置 → 机器人 → 添加机器人 → 自定义（通过 Webhook 接入自定义服务）**。
2. 安全设置选**加签**（推荐）。配好后得到两样东西，记下来：
   - **Webhook 地址**：形如 `https://oapi.dingtalk.com/robot/send?access_token=xxxx`
   - **加签密钥**：形如 `SECxxxxxxxx`
   - （用「自定义关键词」也行：关键词填 `Jira`，通知标题里都带 `[case编号]`… 关键词得出现在消息里，填你通知文字里一定有的词即可；家里宽带没有固定 IP，别用 IP 白名单。）
3. **@人的白名单**：机器人只能 @ 手机号在白名单里的人。把要 @ 的同事手机号都列上（见下面 `config.json` 的 `at`）。这是安全边界：万一哪条事件文字里混了 `@手机号`，也 @ 不到白名单以外的人。

## 三、配四个文件（都在 `~/.agent-autoloop/` 下）

### 1. `work/jira-watch/jira.json` —— 查什么（JQL 随你改）

```json
{
  "mcp": ["uvx", "mcp-atlassian==0.23.0"],
  "jql": "project = DEMO AND updated >= '-20m' ORDER BY updated DESC",
  "envFile": "jira.env",
  "maxResults": 20,
  "timeoutSeconds": 120
}
```

- `jql`：你的自定义查询。窗口和 cron 间隔**重叠没关系**——同一条更新只通知一次（编号 = case + 更新时间）。cron 15 分钟一次，窗口就写 `-20m`；要盯的 project、人、状态随便加条件。
- `envFile`：密钥文件，相对这个目录。

### 2. `work/jira-watch/jira.env` —— Jira 密钥（别提交到任何仓库）

就是当初配 mcp-atlassian 用的那组环境变量。你已经配过 ZCode，值在 `~/.zcode/cli/config.json` 的 `mcp.servers.mcp-atlassian.env` 里（配过 Claude 的话在 `~/.claude.json` 同名位置），照抄过来：

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

### 3. `work/jira-watch/users.json` —— @谁（jira 创建人 → 手机号）

键写 jira 账号的**邮箱**（优先）或**显示名**，值是要 @ 的手机号：

```json
{
  "zhang.san@example.com": { "name": "张三", "mobile": "13800001111" },
  "李四": { "name": "李四", "mobile": "13900002222" }
}
```

没映射到的创建人照样收到通知文字，只是不 @。**这个手机号必须同时出现在钉钉机器人的 `at` 白名单里才会真的 @。**

### 4. 规则和通道 —— 合入 `~/.agent-autoloop/rules.json` 与 `~/.agent-autoloop/config.json`

把本目录 `rules.json` 的 `sources`、`agents`、`rules`、`channels` 各段合进你的 `~/.agent-autoloop/rules.json`，注意：`worker` 按你 `agent-autoloop status` 里显示的电脑名改；`channels` 里的 `dingtalk` 编号和 config.json 保持一致。

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

- 用「自定义关键词」方式的机器人：删掉 `secret` 那行即可。
- `at`：@白名单，手机号数组。
- 改完 config.json 要重启中台（`agent-autoloop up`）。

## 四、验证

```bash
# 1. 先看 MCP 通不通、JQL 对不对：直接打印 jira 返回的原文
node ~/.agent-autoloop/work/jira-watch/watch.ts ~/.agent-autoloop/work/jira-watch/jira.json --dry-run

# 2. 规则写得对不对
agent-autoloop check

# 3. 真跑一轮：把 cron 临时改成 "*/2 * * * *"，等两分钟，看事件和通知
agent-autoloop status        # 应看到「看 Jira 更新」一轮 done，命中数 > 0
agent-autoloop why <轮次号>   # 能查到这条更新的来龙去脉
# 钉钉群里应收到通知；有人被 @ 说明映射和白名单都配对了

# 4. 确认去重：再等一轮，没有新更新的话不会再发同样的通知
```

验完把 cron 改回 `*/15 * * * *`。

## 常见问题

- **第一次跑超时**：uvx 要下载 mcp-atlassian，先手动 `uvx mcp-atlassian==0.23.0 --help` 预热一次。
- **通知发了但没 @ 到**：手机号要**三处一致**——users.json 的映射、config.json 的 `at` 白名单、通知文字里的 `@手机号`（前两处配对，文字是脚本自动拼的）。还 @ 不到就是该手机号没绑定钉钉账号。
- **JQL 命中 0 条**：`--dry-run` 看返回；`updated >= '-20m'` 的窗口内确实没改动。
- **令牌过期**：`jira.env` 里的 `JIRA_PERSONAL_TOKEN` 换新值，不用动别的。
- **想让通知更像人话**：把规则「通知钉钉群」的 `to` 换成你的模型 Agent（`use: "codex"` 等），给它写个 Skill 读事件资料写通知——那就开始花 Token 了，本模板默认不用。

样例数据都是虚构的；脚本只用本地假 MCP 和假 HTTP 验证过，没在真实 Jira 和真实钉钉群上跑过完整链路，首次启用请按上面第四节先验证。

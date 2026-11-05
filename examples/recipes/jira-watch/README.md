# Jira 更新通知钉钉群（@创建人）

定时用你本地已装好的 jira MCP 按自定义 JQL 查 case 更新，把更新发到钉钉群，并 @创建人。

全程只跑脚本，**不跑模型、不花 Token**：

```
每 15 分钟 ──▶ watch.ts（调本地 jira MCP 查你的 JQL）──▶ 事件（按「case + 更新时间」编号，重复读只记一次）
      ──▶ notify.ts（拼通知文字 + @创建人）──▶ 通知卡片 ──▶ 钉钉群机器人（加签）──▶ @创建人
```

换检查频率改规则里的 cron；查什么改 `jira.json` 里的 JQL；@谁改 `users.json` 的映射。

## 钉钉 @ 的规矩（先看这段，不然 @ 不出来）

钉钉的 @ 认三种标识，**都不认 Jira 里的名字**：

| 写法                                                     | 效果                       |
| -------------------------------------------------------- | -------------------------- |
| 文字里写 `@王亮`，但 `at` 白名单里没有                   | 只是普通文字，**没有提醒** |
| 文字里写 `@Gruby.Wang`（群里那个人的写法）+ 白名单里有它 | 真的 @ 到人                |
| 文字里写 `@13800001111`（手机号）+ 白名单里有它          | 真的 @ 到人                |

手机号可以写成 `+86-138xxxx`，程序会归一化成 11 位再发。

官方说明：消息正文里要带上「@手机号」或「@userId」，并与请求里的 `atMobiles` / `atUserIds` 对应，才有 @ 效果。

所以这套要做两件事：

1. `users.json` 把 Jira 账号映射到**群里那个人的写法**（`mention` 字段）。
2. `config.json` 的通道项写 `at` 白名单，列出允许被 @ 的写法。

名单里没写的人照样收到通知文字，只是不会被提醒——这是刻意的：事件里的文字不该能决定 @ 谁。

**用什么写法 @，得实测。** 钉钉认「群里那个人的写法」，各家不一样：

- **群昵称**：最常见。像「Gruby.Wang」这样，英文名按点分段、每段首字母大写——但不是每人都这样，要一个个试。
- **手机号**：`mobile` 字段，填 `+86-138xxxx` 也能认。
- **userId**：企业内部应用调通讯录接口才能拿到，本模板用不上。

**钉钉号（`dingTalkId`）不能用来 @。** 官方把 `userId` 和 `dingTalkId` 列为两个独立字段，「钉钉号」是可改的个人号。

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
   - （用「自定义关键词」也行：关键词填 `CH`，通知标题里都带 `[CH-xxx]`，关键词一定出现在消息里；家里宽带没有固定 IP，别用 IP 白名单。）
3. **@白名单**：把允许被 @ 的 userId 抄进 `config.json` 的 `at` 数组（见第三节）。

## 三、配四个文件（都在 `~/.agent-autoloop/` 下）

### 1. `work/jira-watch/jira.json` —— 查什么（JQL 随你改）

```json
{
  "mcp": ["uvx", "mcp-atlassian==0.23.0"],
  "jql": "project = CH AND updated >= '-20m' ORDER BY updated DESC",
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

### 3. `work/jira-watch/users.json` —— @谁（Jira 创建人 → 群里那个人的写法）

键写 Jira 账号的**邮箱**（优先）或**英文名**；值里的 `mention` 是要 @ 的写法，`name` 只是显示用的名字：

```json
{
  "zhang.san@shijigroup.com": { "name": "张三", "mention": "Zhang.San" },
  "li.si@shijigroup.com": { "name": "李四", "mention": "13900002222" }
}
```

- `mention` 写群里那个人被叫的写法：群昵称（`Zhang.San`）或手机号（`13900002222`）。哪个能 @ 到人，得在群里试。
- 同一人的邮箱可能有两个域（`@shijigroup.com` 和 `@cn.shijigroup.com`），脚本两个都会试，映射表写哪个都行。
- 没有 `mention` 就只发文字、不 @ 人。
- 本目录的 `users.example.json` 是按公司名单填好的样例：`mention` 是按「英文名按点分段、每段首字母大写」猜的，
  猜错的 @ 不生效，收到真实通知后按群里显示的写法改。

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
      "at": ["Zhang.San", "13900002222"]
    }
  }
}
```

- 用「自定义关键词」方式的机器人：删掉 `secret` 那行即可。
- `at`：允许被 @ 的 userId（和 `users.json` 里的 `userid` 对应）。
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
- **通知发了但没 @ 到人**：三处要对上——`users.json` 的 `mention`、`config.json` 的 `at` 白名单、正文里的 `@写法`（前两处配对，正文是脚本自动拼的）。还 @ 不到，多半是这个写法不是群里叫他的那个，把群里显示的名字抄进 `mention`。
- **想知道群里到底叫什么**：在群里点开那个人，看他名字旁边显示的那一串，抄进 `mention`；或者在群里手动 @ 他，看消息里长什么样。
- **JQL 命中 0 条**：`--dry-run` 看返回；`updated >= '-20m'` 的窗口内确实没改动。
- **令牌过期**：`jira.env` 里的 `JIRA_PERSONAL_TOKEN` 换新值，不用动别的。
- **想让通知更像人话**：把规则「通知钉钉群」的 `to` 换成你的模型 Agent（`use: "codex"` 等），给它写个 Skill 读事件资料写通知——那就开始花 Token 了，本模板默认不用。

样例数据都是虚构的；脚本只用本地假 MCP 和假 HTTP 验证过，没在真实钉钉群上跑过完整链路，首次启用请按上面第四节先验证。

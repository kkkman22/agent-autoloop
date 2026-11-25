# 功能使用文档

写给每天用它的人。安装见 [INSTALL.md](../INSTALL.md)，卖点和原理见 [README](../README.md)，给 Agent 看的配置手册在 [SKILL.md](../skills/agent-autoloop/SKILL.md)，协议全文在 [protocol.md](protocol.md)。这份文档只讲「有什么功能、平时怎么用」。

## 一分钟总览

| 你想做什么 | 用什么 |
| --- | --- |
| 看现在都在干嘛 | `agent-autoloop status` |
| 回答一张卡片 | `agent-autoloop answer <卡片> <序号>`，或点飞书/网页里的按钮 |
| 查一轮的来龙去脉 | `agent-autoloop why <第几轮>` |
| 让它每天/每圈定点干活 | `rules.json` 里写 `cron` 规则 |
| 让它接 GitHub / GitLab / 自家系统的事件 | `sources` + Webhook，或定时轮询脚本 |
| 让它接新的命令行 Agent | `agents` 里一行配置 |
| 让卡片发到飞书 / 钉钉 / Slack | `channels` 里接通道 |
| PR 自动审查、合并、上线 | 交付插件（打 `deliver` 标签） |
| 备份 / 恢复 / 换密钥 | `backup` / `restore` / `key rotate` |

配置和数据的家：`~/.agent-autoloop/`。程序在 `app/`，规则在 `rules.json`，密钥和配置在 `config.json`，第三方插件在 `plugins/`，插件的密钥放 `secrets.env`，日志在 `logs/`，备份在 `backups/`。

## 快速上手

1. 装：`curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh`（Windows 用 `install.ps1`，详见 INSTALL.md）。
2. 验证：`agent-autoloop doctor` 看连接，`agent-autoloop try` 用你本机的 Agent 真实走一遍「提问 → 等你回答 → 接着干完」。非交互终端里它会打印问题和一个 `agent-autoloop answer 1 <序号>` 命令后退出，照着答，再跑 `agent-autoloop status` 看到「试跑通过」。
3. 写第一条规则（见下）。
4. `agent-autoloop check` 校验，几秒内自动生效。

## 每天怎么用

### 看和答

- `agent-autoloop status`：谁在线、等什么、在跑什么、做过什么，加上今天和最近 7 天的轮数、Token、费用。`--json` 输出 `/v1/state` 原样结构给脚本用；别人写的文字默认去掉控制字符，想原样看加 `--raw`。
- `agent-autoloop answer <卡片> <序号>` 回答选择题；`answer <卡片> --text 别的想法` 写自由内容；`agent-autoloop resolve <卡片> <结果>` 不选题、直接结案，结果原样留在卡片上。
- `agent-autoloop stop <第几轮>` 停掉一轮，等整个进程组退出才报告已停。
- `agent-autoloop why <第几轮>`：这轮为什么跑、谁领的、结果是什么、卡片发到哪，一条命令查清。`--json` 给脚本，`--raw` 看原文。
- `agent-autoloop runs [规则]` 列做完的轮次，`--before <第几轮>` 往前翻，`--json` 给脚本。

卡片链接一周后失效，之后打开和提交都返回 410；卡片还开着就用 `answer` 命令答。

### 让它现在 / 以后跑

- `agent-autoloop run <规则>` 立即跑一轮（`--subject 对象`、`--reason 说明` 可选）。
- `agent-autoloop pause <规则> --reason 原因` 暂停；到点自动恢复加 `--until 时间`。暂停期间来事件不接也不排队。
- `agent-autoloop resume <规则>` 恢复，会列出暂停期间跳过的事件；要补跑就照它打印的 `agent-autoloop replay <规则> --since <时间>` 执行，一次补完，每条只补一次。
- `agent-autoloop emit <类型>` 手工发一条事件；`--dry-run` 只预演会派给谁，不连中台不写日志。

这些动作记在中台日志里，不改 `rules.json`。

### 改规则

- 直接改 `~/.agent-autoloop/rules.json`，保存几秒内生效；写错了旧规则继续跑，并发卡片告诉你错在哪。
- `agent-autoloop check [文件]`（=`rules validate`）校验并给警告；`check <草稿>` 只读草稿，不碰正在跑的中台。
- 结构化改规则优先用命令，都先预览影响（会取消哪些排队轮次、关闭哪些卡片），确认后旧文件存成 `rules.json.<时间>.bak` 再原子替换；非交互加 `--yes`：
  - `rules explain [文件 | <来源> <事件类型> | <规则名>]`：看生效的规则、下次定时、一条事件会接的规则。
  - `rules diff [文件]` 只看不改；`rules edit` 用 `$EDITOR` 改；`rules disable|enable|remove <规则名>`。
- 删掉或改名一条规则：没领走的排队任务取消，没收尾的卡片关闭并各发一张通知；回答旧卡片返回 409，先用 `resolve` 结掉。已领取的任务会跑完。

### 在别处跑的任务找你

`rules.json` 顶层 `elsewhere` 里登记别的定时任务，`status` 会列出来；`agent-autoloop tell <编号> --task <任务名>`（内容从标准输入读）给它捎话；要它带选项找你拍板，让任务运行 `agent-autoloop ask --task <任务名>`，你答完中台在规则的 `cwd` 里叫醒它的 Agent 接着做。

## 让它接到活：事件

三种接法（配置写在 `rules.json` 的 `sources`）：

1. **对方能发 HTTP**：`agent-autoloop key new source <名字>` 拿密钥，对方 `POST /v1/events`；要查后续结果用同一把密钥 `GET /v1/events/<事件编号>`。
2. **对方有自己的 Webhook 格式**：写一个 source 插件验签翻译（照 `plugins/github/source.ts`），地址 `/v1/in/<来源>`，秘密放 `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_<来源>`，改完 `agent-autoloop service install` 重启。
3. **对方推不过来**：定时跑脚本轮询（照 `examples/recipes/github-issues/watch.ts`），规则用 `use: "command"` 的 Agent 加 `emits`，没新东西不花 Token。

外部事件只能带资料：标题、正文这类文字进不了提示词，也决定不了用哪个 Agent、哪个目录、什么权限——事件里带 `cwd`、`agent`、`access` 会被直接拒收。Agent 交回的事件继续派发会累加跳数，超过 8 层只记录不再派活。

开发新插件先在测试中台跑 `agent-autoloop conformance <地址> --config <测试凭据文件>`，不指向正在用的中台。

## 让谁来干活：Agent

`rules.json` 的 `agents` 里登记。内置：`claude`（Claude Code）、`codex`、`acp`、`dsh`（DeepSeek Harness）、`zcode`、`command`（通用命令）。

```json
{
  "agents": {
    "hermes": { "name": "Hermes", "worker": "my-mac", "use": "command", "command": ["hermes", "chat", "-Q", "-q", "{prompt}"] }
  }
}
```

- `use: "command"`：任何能打印最后一条回复的命令都行，`{prompt}` 作为独立参数传，不当 shell 执行。退出码非 0 算没跑成。
- `use: "acp"`：会说 ACP 的 Agent（Gemini CLI、OpenCode、Agentica、Antigravity……），能续接原会话。
- 第三方网关 / 代理：写个设好环境变量再 `exec` 的小脚本，Agent 里写 `"program": "脚本绝对路径"`，会话续接和用量统计照旧。
- `access` 默认 `edit`；`full` 是完整权限不审批，先想清楚再写。`timeout` 单位分钟，默认 180。
- `worker` 指定在哪台接单电脑跑；不写就在任一台有空位的。
- Claude Code 订阅用量到上限：中台按它报的恢复时间暂停派活，排着的事件到点自动接着做，`status` 里写几点恢复。

## 找你拍板：通道

`rules.json` 的 `channels` 登记（谁能回答），`config.json` 的 `channels` 写密钥和选项。

- **桌面通知**：新装默认开着，只能提醒，不能在通知上回答；没有图形会话时安静跳过。
- **飞书**：官方 `lark-cli`，卡片按钮回调；一个应用的卡片点击只能有一个监听。
- **钉钉 / 企微 / Slack / Discord 等纯文字 Webhook**：`"use": "webhook"` + 平台名和地址；任何收 JSON POST 的服务都能接。写 `"links": true` 让卡片链接本身可以回答，`config.json` 的 `hub.publicUrl` 要配成手机能打开的地址。
- **回答资格**：通道的 `answerers` 名单缺失或为空 = 只能收通知，谁都不能答；显式 `["*"]` 才谁都能答。顶层 `roles`（如 `{ "运维": ["ou_a", "13800000000"] }`）+ 规则里 `answerers: ["role:运维"]` 可按角色限定；名单在卡片创建时展开，之后改角色不影响已发出的卡片。本人用命令行或密钥回答不受名单限制。
- **夜里安静**：通道加 `quiet: { "from": "22:00", "to": "08:00" }`，安静时段普通卡片不发、时段结束补发；规则加 `severity`（`low` / `normal` 默认 / `urgent`），`urgent` 不受限。
- **卡片去哪**：默认发所有通道；规则写 `channels: ["feishu"]` 只发这些；顶层 `defaultChannels` 收纳「不属于任何规则」的卡片（`tell`、规则写错、接单程序离线等）。

写自己的通道插件照 `plugins/feishu/channel.ts`，卡片页面是唯一内置网页：一个不跑脚本的表单，给只会发文字的通道用；打开链接不算回答，别人写的字不会被当标记渲染。

## rules.json 字段速查

| 字段 | 写在哪 | 作用 |
| --- | --- | --- |
| `when` | 规则 | `{ "cron": "0 9 * * *" }` 或 `{ "source": "github", "types": ["issues.opened"] }`（支持 `*`） |
| `to` | 规则 | `agents` 里的名字 |
| `cwd` | 规则 | 在哪个目录干（也可给 `elsewhere` 任务，供 `ask` 叫醒用） |
| `skill` / `prompt` | 规则 | 照什么手册做 / 提示词 |
| `parallel` | 规则 | 同一对象并发几轮；同一组的规则写一样的值 |
| `group` | 规则 | 并发分组，和 `worker.capacity` 配合留名额 |
| `maxActive` | 规则或 Agent | 这条规则 / 这个 Agent 同时最多几轮 |
| `resume` | 规则 | `true` = 同一对象的新事件接着上一轮会话；默认开新会话 |
| `title` | 规则 | 会话标题模板，如 `"tapd-{id}-测试"` |
| `tags` | 规则 | 原样带进 `/v1/state` 和资料文件 |
| `channels` | 规则 | 这条规则的卡片只发这些通道 |
| `severity` | 规则 | `low` / `normal` / `urgent`，配合通道 `quiet` |
| `answerers` | 规则 | 这条规则的卡片谁能答，如 `["role:运维", "ou_xxx"]` |
| `disabled` | 规则 | `true` = 暂停：事件照记照排队，只是不派 |
| `emits` | 规则 | `use: "command"` 的轮次交回执时触发的事件 |
| `worker.capacity` | 顶层 | 一台接单程序同时跑几轮，默认 2 |
| `agents` / `sources` / `channels` / `roles` / `elsewhere` / `defaultChannels` / `notices` / `askFirst` / `rules` | 顶层 | 见上文各节 |

## 命令速查

| 命令 | 干什么 |
| --- | --- |
| `up` | 前台启动中台（装了服务就不用手动跑；一轮里 `up` 想重启派它来的中台会被拒绝） |
| `init` | 首次安装配置（`--agent`、`--command`、`--port`、`--no-service`） |
| `join <地址> --worker <名> --key <密钥>` | 把这台电脑接进远程中台，只接受 https（本机回环可 http） |
| `status [--json|--raw]` | 全局状态与用量统计 |
| `try` | 真实走一遍问答闭环 |
| `doctor` | 体检：服务、密钥、Agent 登录、插件异常 |
| `answer <卡片> [序号] [--text …]` | 回答卡片 |
| `resolve <卡片> <结果>` | 结案 |
| `ask --task <任务名>` | 给 `elsewhere` 任务发问题卡片（内容从标准输入读） |
| `tell <编号> --task <任务名>` | 给 `elsewhere` 任务捎话（内容从标准输入读） |
| `stop <第几轮>` | 停一轮 |
| `why <第几轮> [--json|--raw]` | 查一轮来龙去脉 |
| `runs [规则] [--before <轮>] [--json]` | 列做完的轮次 |
| `run <规则> [--subject 对象] [--reason 说明]` | 立即跑一轮 |
| `pause <规则> [--reason 原因] [--until 时间]` / `resume <规则>` | 暂停 / 恢复 |
| `replay <规则> --since <时间>` | 补跑暂停期间跳过的事件 |
| `emit <类型> [--dry-run] …` | 手工发 / 预演事件 |
| `check [文件]`（=`rules validate`） | 校验规则 |
| `rules explain / diff / edit / disable / enable / remove` | 结构化看改规则，先预览再写回 |
| `key new <source\|worker\|channel\|owner> <名>` / `key list` / `key remove <种类> <名>` / `key rotate [--yes]` | 密钥管理；`remove` 立即生效，长轮询和订阅马上失效 |
| `backup [目录]` / `restore <目录> [--yes]` | 备份（中台在跑也行）/ 恢复（要先停） |
| `update [--check | <版本> | --rollback]` | 更新 / 指定版本 / 回滚 |
| `service install\|remove` | 装 / 卸登录常驻服务 |
| `plugins list / update <名> [--check] / trust <名> <公钥> / remove <名>` | 插件管理（签名不对拒装） |
| `add <git 地址> [--ref v版本]` | 装第三方插件 |
| `conformance <地址> --config <文件>` | 对测试中台跑协议一致性检查 |
| `mcp [--allow-writes]` | 起 MCP 服务（默认只读：`status`、`why`） |
| `uninstall [--yes]` | 卸载程序；规则、密钥、记录保留 |

## HTTP 接口速查

都走中台地址（默认 `127.0.0.1:3350`），密钥按调用者区分，超量回 429 带 `Retry-After`：

| 接口 | 谁 | 干什么 |
| --- | --- | --- |
| `POST /v1/events` | 来源密钥 | 发事件 |
| `GET /v1/events/<编号>` | 来源密钥 | 查这条事后续做完没 |
| `POST /v1/in/<来源>` | 无（插件验签） | 自有 Webhook 格式的入口 |
| `GET /v1/work` | 接单密钥 | 领活 |
| `GET /v1/cards/next` | 通道密钥 | 领卡片 |
| `GET /v1/state` | 本人密钥 | 全局状态（总览页数据源） |
| `GET /v1/stream?after=<seq>` | 本人密钥 | 按序号续读事实日志 |
| `GET /v1/runs` | 本人密钥 | 轮次列表 |
| `GET /v1/metrics` | 本人密钥 | Prometheus 文本指标（不含卡片和事件文字、不含密钥） |
| `POST /v1/tell` | 本人密钥 | 发通知卡片（`text` 最多 20000 字） |
| `POST /v1/rules/preview` | 本人密钥 | 规则改动预演 |
| 卡片链接（`hub.publicUrl`） | 链接自带 token | 看卡、答卡；一周后 410 |

## Agent 怎么找你（回执代码块）

中台对 Agent 只有一个约定：**在最后一条回复里交代结果**。需要人介入时在回复末尾附一段 ` ```agent-autoloop ` 代码块：

- `ask`：提问卡片，带 `title`、`text`、`options`、`key`；用户答完接着原会话干。
- `notice`：通告（不用回答），只想告知一声标 `fyi`；结案说明可写在 `resolve` 的 `about` 里，留在卡片上。
- `resolve`：关闭已解决的卡片。
- `later`：预约复查，到点回到原会话。
- `events`：触发新事件（跳数 +1，超过 8 层不派发）。

JSON 写坏了，中台只让它在原会话里重写最后这段回复，不重做业务；重写也失败就保留原结论并通知你。

## 交付流水线（GitHub / GitLab）

给 PR 打 `deliver` 标签，它自己跟进：审代码 → 等 CI → 合并 → 等部署 → 核对线上版本。审查、合并判断只从目标仓库 `main` 的 `ops/delivery.json` 读设置；接单电脑不检出、不运行 PR 里的代码，只把裸 Git 对象变成文字快照给审查器。

- `deliver-review` 只审查；`deliver-attended` 表示有人确认过（受保护路径改动必须它或人工放行）；`ask-owner` 变问题卡片。
- 受保护路径：`.github/**`、`scripts/**`、`tests/**`、`package.json`、`package-lock.json`、`ops/delivery.json`（设置里 `protected` 可替换）。
- 审查按写代码的 Agent 分开配（`review.agents`），可免审、可换命令、可指定模型和推理深度；审查是建议，不是安全门禁。
- GitLab 同一套规则：接单机设 `AGENT_AUTOLOOP_DELIVERY_HOST=gitlab`（用已登录的 `glab`），MR 草稿是标题前缀，完整检查是流水线。
- 中台停机时的应急单发：`node plugins/delivery/run.ts owner/app --pr 123`（加原规则的审查参数）。

完整配置（`check`、`ship`、`health`、`review.points`、`trusted_submitters`、自建审查命令等）见 [SKILL.md 的交付流水线一节](../skills/agent-autoloop/SKILL.md#交付流水线)。

## 运维

- **服务**：macOS/Linux `agent-autoloop service install` 装登录常驻服务；Windows 用任务计划程序（Administrator 账号走「启动」文件夹，`service install` 会打印做法）。日志：macOS/Linux `~/.agent-autoloop/logs/up.log`（Linux systemd 用 `journalctl --user -u agent-autoloop`），Windows `%USERPROFILE%\.agent-autoloop\logs\up.log`。
- **更新**：`update --check` 只看；`update` 更新；`update <版本>` 换版本；`update --rollback` 回滚。更新前先 `backup`。投影格式变了会自动从日志重建，历史多时首次启动等一等，中途断了下次接着做。
- **备份恢复**：`backup [目录]`（数据库 + 主密钥 + 配置 + 规则，权限只给本人，中台在跑也能备）；`restore <目录> --yes`（要先停中台，先核对清单哈希和事实条数，旧数据留 `replaced-<时间>`）。换主密钥 `key rotate --yes`：旧卡片链接和在途轮次凭据立刻失效，`key new` 建的访问密钥不受影响。
- **多台电脑**：中台放有公网的机器（前面加 HTTPS 反代，`hub.listen` 写完整 `主机:端口`），干活的电脑 `join` 过去，不用开放任何端口。
- **限量**：每把密钥、每一轮、每个 Webhook 来源分开算，超了 429；日志里 `limited <调用者>` 说明是谁。默认值碰不到，真碰到在 `config.json` 的 `hub.limits` 调。
- **监控**：抓 `GET /v1/metrics`（Prometheus 文本）；要页面就读 `/v1/state` 自己写一个，官方示例客户端是 `agent-autoloop-console` 仓库。
- **MCP**：给编辑器/Agent 配 `node <安装目录>/bin/agent-autoloop.ts mcp`，默认只读；要回答、结案、停轮、发事件加 `--allow-writes`。别把它配进接单程序启动的 CLI 的用户级配置，否则一轮能自己答自己的卡片。

## 常见问题

| 现象 | 看哪 |
| --- | --- |
| 起不来，日志 `listen EACCES`（Windows） | 端口落进 Hyper-V/WSL 保留范围，`netsh int ipv4 show excludedportrange protocol=tcp` 查看，`config.json` 换端口 |
| 飞书点卡片没反应，日志说「另一条事件连接」 | 飞书那边还记着旧连接（可能几小时），中台每分钟重试；先停别的电脑上的监听 |
| 卡片链接打不开（410） | 链接过了一周期，用 `answer` 命令 |
| 回答旧规则的卡片被拒（409） | 规则删了/改名的旧卡片，先 `resolve` 结掉 |
| 中台一直不派活，`status` 里 Agent 后面有时间 | Claude Code 用量到上限，到点自动恢复；想提前试对它一条规则 `run` |
| 怀疑配置错了 | `doctor` 体检；`rules explain` 看生效样子；改错时旧规则继续跑并推卡片说明 |
| 升级后第一次启动慢 | 在从日志重建视图，进度在标准错误输出，下次启动直接复用 |

## 安全边界速记

- 数据目录只有本人能读（Windows 用 ACL）；`master.key` 权限 0600，坏了中台拒启，从备份恢复或删掉重建（在途凭据失效）。
- 外部文字进不了提示词、决定不了 Agent/目录/权限；回答要同时过通道 `answerers` 和卡片名单（本人密钥除外）。
- 每轮有独立 token，轮次的 token 碰不到别的轮次。
- 交付进程不检出、不运行 PR 代码；审查快照只读、忽略用户配置与记忆。
- 细节见 [SECURITY.md](../SECURITY.md)。

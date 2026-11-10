# LobeHub「AI 团队」调研：文章、lobehub/lobehub、lobehub/acceptance，对照 agent-autoloop

调研日期 2026-11-09。文章是二手宣传稿，关键说法都回到一手来源（PR、源码、官方文档）核实，核实不了的单独列出。源码引用钉在 `lobehub/lobehub@4e48d81f`（验收部分另用 `@47bd681c`）和 `lobehub/acceptance@f720feb`。

## 结论

- **文章的 T-1149 故事是真的，但“全程 Agent 自主”打了折扣。** PR #21852 能证实“AI 写代码 → 自测 → AI 审查 → 附验收报告 → 人工合并”这一段；“主管 Agent 自己发现需求、自己建单”发生在 LobeHub 的私有工作区，公开证据核实不了。最近 100 个 PR 里，维护者 `arvinxx` 本人提了 57 个，专职 AI 账号只提了 5 个：大部分工作还是“人加 AI 辅助”。
- **agent-autoloop 和 LobeHub 想法相通，路子相反。** 两边都是事件驱动，都让 Agent 跑在外部执行环境里，都以任务或事项为上下文中心，都只在关键节点找人。区别在于：LobeHub 让 **Agent 当主管**，由大模型拆任务、派活、生成验收标准，做成云产品加界面；我们让 **规则当主管**（规则是唯一指令，事件里的字只当资料），内核是确定性的，没有界面。
- **最值得借鉴的是 Acceptance 的四条验收规矩**：测试不算验收；没有证据就判“不确定”；干活的 Agent 不给自己打分；只返工没通过的项。还有“验收 → 合并 → 任务完成”这个回环。这些用现有的口子（回执 `events`、`emits`、卡片 `ask`、`deliver` 标签）就能拼出来，**不用改内核**，配置草稿见第 6 节。
- **不建议照搬的**：让主管 Agent 动态决定交给谁、在哪个目录、用什么权限（和“规则才是指令”冲突）；把任务依赖图做进内核；接入 `lh` CLI 和 LobeHub 托管的验收页（数据离开本机，许可不清楚，个人报告拿到链接就能打开）。

## 1. 文章说了什么（二手，没核实）

来源：<https://mp.weixin.qq.com/s/77RKieFLjZ1gPNU6PSD2yA>（标题《GitHub 84K+ Star！DeepSeek 刚提出的 Super-Agent 新架构，有开源已经做成了产品》）。

- 起因：DeepSeek Harness 团队发了《Super-agent 设计探索》，提出 Router + Worker 两层架构，原型在 <https://github.com/deepseek-ai/dsh-superagent-prototype>（本次没有调研）。文章说 LobeHub 半年前就把这个思路用在了自己的生产环境，口号是“用 LobeHub 开发 LobeHub”。
- 三层：Personal Agent（替每个人过滤信息）、项目主管 CAO（内部实例叫 Nasa、Shutter）、专职 Worker（例如编码 Agent Dario，接 Claude Code、Codex，不在群里说话，产出都回到 Task 里）。
- 四个设计：
  1. **两级过滤**：先按规则粗筛（频道、关键词，不花 Token），再由 Agent 判断这件事归不归自己管；定时巡检会主动接活。
  2. **调度和执行分开（BYOM）**：调度在云端，执行在云沙箱或自己的电脑上；本机只跑一个 `lh connect` 守护进程，合上笔记本任务也不停。
  3. **Task 当上下文中心**：一个 Task 里放需求、对话、产物、CI 日志、PR、验收清单；支持依赖链（T-2 做完自动开始 T-3）、并行和定时任务。
  4. **Acceptance 多模态验收**：派活时就拆好验收项，交付后用无头浏览器访问真实产品，逐项验证，留截图、录屏和控制台日志；可以单项打回，已通过的保留；跑挂了如实上报，不编一份全绿的报告。
- 还提到 **Agent Vent**：Agent 碰到报错会自动上报，每天定时把问题聚类，自动建修复 Task。
- 文章自己列的短板（来自评论区，没核实）：调度链路长、响应慢；连本地 API Hub 容易出错；高级自治要付费；Token 消耗随子任务数线性增长。

## 2. 核实结果

| 文章说法                                                   | 一手证据                                                                                                                                                                                                                                                                     | 结论                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| CLI 调任务工具时不能单独指定模型，规划模型和执行模型分不开 | PR [#21852](https://github.com/lobehub/lobehub/pull/21852) 正文：“Tasks already support a per-task model override… but only the web UI could set it. An agent that planned on one model could not create a task that runs on another.” 分支名 `feat/t-1149-task-model-entry` | 属实                             |
| 建了主任务 T-1149，写了验收标准                            | PR 正文：“Related to T-1149 (internal task)”。`T-n` 是 LobeHub 任务编号的格式                                                                                                                                                                                                | 编号属实，内容在私有系统里看不到 |
| 主管 Nasa 发现需求并建单                                   | 公开代码里 Nasa 只出现在注释示例中：`packages/types/src/agent/displayName.ts` 写着 “Nasa (Shadow Arvin)”。推测是维护者 Arvin 的影子 Agent                                                                                                                                    | 核实不了                         |
| 交给跑在 Claude Code 里的 Dario                            | 代码示例 `<agent name="Dario" title="CC 2号机" heteroType="claude-code">`（`packages/prompts/src/prompts/agentBuilder/searchAgentsResultsPrompt.ts`）。PR 作者是 `lobehub-coder`，不是 Dario                                                                                 | 说得通，核实不了                 |
| Dario 编码、自测、提 PR                                    | 作者 `lobehub-coder` 是 2026-10-10 新建的专职账号（0 个仓库、0 个关注者）。正文写明 Harness 是 Claude Code（Agent SDK），实现用 claude-opus-5-5，修审查意见用 claude-sonnet-5-5；“I ran the branch CLI against production”                                                   | 属实                             |
| Acceptance 自动验收，生成报告                              | 正文附两份报告链接 `app.lobehub.com/acceptance/<id>`（要登录才能看）                                                                                                                                                                                                         | 属实，报告内容没看到             |
| 人工复核后合并                                             | Codex 机器人 `chatgpt-codex-connector` 审查；作者自述 AI 审查发现两个 P2 问题，都修了；人类 `arvinxx` 于 2026-11-01T04:32:54Z 合并                                                                                                                                           | 属实                             |
| 人只在最终评审介入                                         | 只有这一个数据点。2026-10-01 以来的 PR 中，正文带 “AI-assisted” 标记的超过 300 个（搜索封顶）；最近 100 个 PR 的作者：arvinxx 57、MarioJames 12、lobehub-coder 5                                                                                                             | 是不是常态核实不了               |

有个巧合：这个 PR 本身就是规划和执行分开做的，实现用 opus，修审查意见用 sonnet。

## 3. lobehub/lobehub 是什么

- 主产品仓库，由 `lobehub/lobe-chat` 改名而来，84.5k stars，默认分支 `canary`，非常活跃。
- **许可有限制**：LobeHub Community License 基于 Apache 2.0，但不改源码才能商用；**做衍生作品并分发要先拿 LobeHub LLC 的商业授权**（[LICENSE](https://github.com/lobehub/lobehub/blob/canary/LICENSE)）。所以我们只借思路，不搬代码。我们本来也没有运行时依赖。
- 多 Agent 机制（括号里是源码位置）：
  - **Agent Groups**：顺序、并行、迭代、辩论四种协作模式，每个组自带一个 Orchestrator（`packages/agent-runtime/src/groupOrchestration/GroupOrchestrationSupervisor.ts`，指令有 `CallAgent`、`ParallelCallAgents`、`Delegate`、`Finish`）。
  - **Goal**：`requirement` 字段写“做到什么算完成”，另有 `maxRounds`、`maxTotalCost`；`goalGraph` 里的 `decisions` 表就是人工决策关口（`resolvedByUserId`）（`packages/database/src/schemas/goal.ts`、`goalGraph.ts`）。
  - **Goal supervisor**：任务失败时起一个虚拟 Agent，它只有 `inspectGoal`、`inspectTask`、`readArtifact`、`resolveInterruption(retry|escalate)` 这几个工具。只有 429、配额这类传输错误会自动重试，其余一律交给人工关口；介入次数有上限，默认 10（`apps/server/src/services/goal/supervisor/README.md`）。
  - **Task**：`T-n` 编号、父子任务、`taskDependencies`；可以派给 Agent 也可以派给人；`automationMode` 有 `schedule`（cron）和 `heartbeat` 两种；`config.model/provider` 覆盖模型（`packages/database/src/schemas/task.ts`）。状态有 backlog、running、scheduled、paused、completed、failed、canceled。
  - **任务工具**共 15 个：`createTask(s)`、`editTask`、`runTask(s)`、`setTaskVerify`、`setTaskSchedule` 等（`packages/builtin-tool-task/src/manifest.ts`）。
  - **验证关口** `setTaskVerify`：用一句话写 requirement，**服务端据此生成验收标准**；验证 Agent 和干活的 Agent 分开（`verifierAgentId`）；最多修 1 到 10 轮。原话是 “the executing agent's 'done' is verified by a separate reviewer rather than blindly trusted”。
  - **外部 Agent**：13 个编码 CLI（Claude Code、Codex、Cursor、OpenCode、Pi、Kimi Code、CodeBuddy 等），加上 OpenClaw 和 Hermes；都跑在“执行设备”上，可以是桌面应用、用 `lh` CLI 接入的电脑或云沙箱（`packages/heterogeneous-agents/src/adapters/`，[文档](https://lobehub.com/docs/usage/agent/connect-external-agents)）。
  - **GitHub App 回环**（[文档](https://lobehub.com/docs/usage/integrations/github)）：PR 正文带验收链接就和任务关联。合并后验收算通过，任务完成；CI 失败会叫醒原来的 Agent（每个 PR 最多 3 次，草稿不叫醒）；审查意见送回 Agent 的会话。**只有仓库成员和 Codex 机器人的评论能叫醒 Agent**，其他人的评论 “never become instructions for an Agent”。
  - **通道**：自带 Discord、Slack、Telegram、LINE、QQ、微信、飞书、Lark 机器人；bot-wake 系列 PR（#21675、#21715、#21719、#21728）做了点名叫醒、线程跟进窗口、多人线程里主动让开。

## 4. lobehub/acceptance 详细调研

### 4.1 它是什么（和文章给人的印象不一样）

- **它不是 CI 服务、GitHub Action 或机器人，而是一个 Agent Skill**：一组 Markdown 指令（`skills/acceptance/SKILL.md`、24 篇参考文档、5 篇界面指南）加 5 个小脚本。装进项目后，由你已经在用的编码 Agent 加载，自己动手验收。
- Apache-2.0，v0.10.0；2026-09-21 创建，最后一次提交在 2026-10-27；44 次提交、17 个 tag，没有 Release；93 stars；5 个贡献者全是内部人员；一共只有 1 个 issue。Markdown 4667 行，脚本加测试 2006 行；没有任何依赖。
- **打开 PR 不会触发它**：“Creating or updating a PR, marking it ready, or being asked to upload a report must not by itself start another verification run”（`SKILL.md:28-32`）。

### 4.2 一次验收怎么跑

1. 怎么触发：人对 Agent 说“用 Acceptance 验证”（Claude Code 里是 `/acceptance:acceptance`，Codex 里是 `$acceptance`）；或者 LobeHub 的 Task 开了验证，任务提示词让 Agent 加载这个 Skill。
2. 先从六个动作里选一个：跳过（纯文档或纯重构）、复用已发布的报告、复用本地报告、上传已有证据、用本次会话已经看到的内容写报告、只跑缺的和受影响的项。
3. 给检查项定固定编号，启动真实产品，用外部工具操作：网页和 Electron 用 `agent-browser`，macOS 用 `osascript`，iOS 模拟器用 `sim-use` 或 AXe。
4. 收证据：截图、分章节的录像、网络日志、改动前后对比。需要时临时改源码注入 `throw` 造出错误状态，事后再改回去。
5. 每次验收产出一个不能再改的“轮次”目录：`.acceptances/<主题>/<时间>-<名字>/result.json` 加 `assets/`。`result.json` 里有 `plan[]`（`id`、`verifier: program|agent|llm`、`requiredEvidence`）、`cases[]`（`pass|fail|blocked`）和 `summary.verdict`（`pass|fail|partial`）。
6. 用 `lh` 生成离线的 `report.html`，或者上传到 LobeHub 托管页；人逐项接受或打回。
7. Skill 内部分三个角色：主 Agent（干活的那个，负责范围和改代码）、runner（换一个便宜模型，新开上下文，负责操作产品和收证据）、checker（便宜模型，只在第一轮审计划和证据；必须打开每张图、看录像，原话 “file existence and captions are not visual verification”）。宿主不支持子 Agent 时，必须在报告里写明“没有独立审查”。

### 4.3 四条最值钱的规矩

1. **测试不算验收**。`SKILL.md:232` 写着 “HARD RULE — programmatic gates are NEVER acceptance checks”：单测、覆盖率、tsc、lint、build、“CI 绿了”只能写成报告里的一行说明。导入时这类项会被剔掉，全是这类项的轮次发布不了。
2. **没有证据就判“不确定”**。声明了 `requiredEvidence` 的检查项 “cannot pass on your text alone”（`SKILL.md:19`）。服务端先过一道**不用模型的证据关**：缺证据就判 `uncertain`。之后才轮到大模型裁判，裁判被要求 “default to 'uncertain' rather than 'passed' when evidence is missing”（`apps/server/src/services/verify/executor.ts`、`packages/prompts/src/chains/verify.ts:328`）。
3. **干活的不给自己打分**。任务提示词原话：“Do not judge the Acceptance — submit evidence only; an independent verifier decides whether this Task is complete”。
4. **只返工没通过的项**。轮次发布后就不再改；修好后发一个新轮次，已经接受的项跳过，被打回的项沿用原编号，用 `supersedes` 标明替换了谁；没跑的项显示“未执行”，不会消失；“a blocked case is not a pass”。服务端的修复循环默认最多 3 轮，每一轮单独核验，“evidence from earlier rounds does not carry over”。

### 4.4 短板

- **没有沙箱**：直接在 Agent 自己的工作区起开发服务器，还会临时改源码；资源守卫只管内存，不支持原生 Windows，在 Linux 上也不看 cgroup。
- **没有防提示注入的措施**：全仓找不到 “untrusted” 或 “prompt injection”；服务端把需求、干活 Agent 的回答、证据内容和审查评论原样拼进裁判的提示词；人打回时写的话也原样进入下一轮的提示词。
- **行为全靠文字描述**：测试只覆盖脚本，没有检查“Agent 照着 `SKILL.md` 做，能不能得出正确结论”。
- **离不开 LobeHub**：渲染、上传、读回审查意见都要 `lh`（`@lobehub/cli`，源码在 lobehub/lobehub，npm 上没写许可证，GitHub 显示 NOASSERTION）；服务端的自动判定只对 LobeHub Task 建出来的轮次生效；本地模式没有评论、审批和分享。
- **平台**：原生截屏只支持 macOS，能放到云上无头跑的只有网页。
- **权限**：个人账号的报告拿到链接就能打开，按报告控制访问权限的功能 “on the way”。
- **太年轻**：才 7 周，5 个内部贡献者，CLI 接口还在变，文档里有大量兼容旧版的分支。

### 4.5 值不值得借鉴

**思路值得借，工具本身不要直接接。**

- 借：4.3 的四条规矩；`result.json` 的 `plan/cases/verdict` 结构（文档是公开的，可以自己写渲染）；每个项目一份 `PROJECT.md`，写清楚怎么启动、怎么登录、怎么进到要验的页面；被打回的问题记进项目里的“踩坑记录”，下一轮开工先读。
- 不接：`lh` 和托管报告（数据离开本机、许可不清、个人报告拿到链接就能看）；不加隔离就在本机改源码验收。另外，我们的交付插件定过底线：交付进程不检出、不运行 PR 代码。所以验收不能放进交付进程，只能做成一条单独的规则，由专用账号或容器里的 Agent 来跑。

## 5. 和 agent-autoloop 对照

| 方面                         | LobeHub                                                             | agent-autoloop                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 谁决定交给谁                 | 主管 Agent（大模型）动态拆任务、派活、生成验收标准                  | `rules.json` 固定写明 Agent、目录、Skill、权限；事件里的字只当资料                                                              |
| 上下文放在哪                 | Task（`T-n`，带线程、产物、PR、验收清单）                           | 事项（同一条规则下同一个对象的事）加 `resume` 接原会话；`why` 能看全部历史                                                      |
| 任务依赖                     | `taskDependencies`，T-2 做完自动开始 T-3                            | 回执 `events` 加规则 `emits` 串起来（`hops` 不超过 8）；没有显式的依赖图                                                        |
| 怎么触发                     | 聊天、cron 或 heartbeat、GitHub 事件、机器人被点名                  | 来源事件（GitHub/GitLab Webhook、HTTP、轮询脚本）、cron 规则                                                                    |
| 两级过滤                     | 先按规则粗筛，再让 Agent 判断归不归自己管                           | 规则 `when` 匹配（不花 Token），Agent 看完可以交 `outcome: nothing`（不用做）                                                   |
| 调度和执行分开               | 云端调度，执行设备用 `lh connect` 或云沙箱                          | 中台加接单程序；`join` 连远程中台（只认 https），可以有多台接单电脑                                                             |
| 什么时候找人                 | `decisions` 表、Pending review 状态、CAO 停下来提问                 | 卡片 `ask`（带选项和推荐）、`askFirst` 清单、`answerers` 名单；一轮不等人                                                       |
| 失败了怎么办                 | 只自动重试传输错误，其余交给人工关口                                | 没跑成就自动重派，并和期间新来的同一事项的事件合成一轮；连续失败就停下发卡片                                                    |
| 验收                         | 验证关口、Acceptance 证据报告、独立裁判                             | 交付插件：Codex 文字审查、完整 CI、合并、Ship、核对线上版本；**没有产品级验收**                                                 |
| 防提示注入                   | 只有成员和 Codex 机器人的评论能叫醒 Agent；验收裁判的提示词没有防护 | 规则才是指令；别人写的字只放进标明“是资料”的文件；通道传来的回答要核对回答人                                                    |
| 工程严谨程度                 | 商业产品（测试情况没调研）                                          | 事实日志是唯一权威状态；确定性内核；20 万步模拟、8! 种顺序穷举、强杀、变异                                                      |
| 产品形态                     | 云产品加界面，高级自治要付费                                        | 没有界面的中台，没有运行时依赖，跑在本机或自己的服务器上                                                                        |
| 规划和执行模型分开（T-1149） | 加了这个 PR，任务工具和 CLI 才能给任务单独指定模型                  | `agents` 里每个 Agent 都能配 `model` 和 `effort`；规划和执行配成两个 Agent、写两条规则就行（`dsh` 和 `acp` 插件不认这两个字段） |

文章当卖点讲的几件事，我们已经有了：“不用 @，该出手时才出手”就是协议原则 1“注意力最贵，默认安静”；“合上电脑任务继续跑”就是远程中台加接单电脑，定时任务错过了醒来只补最近一次；“只在关键节点找人”就是原则 5“一轮不等人”加 `askFirst`。Agent Vent 我们只有一半：失败会重派、会发卡片，但没有自动聚类再建修复任务。

## 6. 我的 AI 开发团队能借鉴什么（按性价比排）

> 2026-11-09 定下来：不用 Orca，AI 团队在本项目自建，验收回环按下面第 1 条做。Orca 的调研留在 [research-orca-2026-11-09.md](research-orca-2026-11-09.md) 备查。

1. **验收回环（最值得做，不改内核）**。写两个任务 Skill：`build-with-evidence`（编码交 `done` 时必须附可以观察到的证据，测试不算）和 `acceptance`（吸收 4.3 的四条规矩，按项目的 `PROJECT.md` 起产品、逐项收证据）。规则这样串：

   - 每 5 分钟跑一次 `examples/watch-github-issues.sh`。它是个 shell 脚本，不调模型：用 `gh issue list` 读最近 30 个带 `agent` 标签、还开着的 issue，每个写成一条事件（`id: issue-123`、`subject: #123`，标题和正文前 4000 字当资料），打印在回执的 `events` 里。来源由规则的 `emits` 定为 `team`；`id` 不变，重复读到的中台只记一次。之所以不直接用 GitHub Webhook 的 `github` 来源，是因为规则的 `when` 只能写一个来源：新 issue 和后面的 `work.rejected` 都放在 `team` 下，「编码」一条规则才能同时接这两种事件，同一个 `#123` 落在同一个事项里，`resume` 接上原会话。不给 `team` 建来源密钥，外面的程序就没法以它的名义发事件；
   - 编码 Agent 交回执时发 `work.ready`（`subject` 沿用 `#编号`）；
   - 验收规则交给**另一个 Agent、换一个模型**（干活的不给自己打分），在单独的目录里检出分支、起产品、收证据，最后用 `ask` 发一张卡片：每项写 pass/fail/uncertain 和证据路径，选项是“通过并交付”和“打回”；
   - 你选“通过”，验收 Agent 回到原会话，给 PR 打上 `deliver`，走现有的交付流水线（审查、CI、合并、Ship、健康核对）；
   - 你选“打回”，它发 `work.rejected`，事件详情里列出没通过的项。这条事件回到编码规则里同一个事项，`resume` 接上原会话，只返工这几项；
   - 回执事件的 `hops` 每过一层加 1，到 8 就不再派发，所以这个回环**最多返工 3 次**，第 4 次打回会停下并通知你，正好和 LobeHub 默认的 3 轮一样。

   下面的规则草稿已经在临时 `AGENT_AUTOLOOP_HOME` 里用 `agent-autoloop rules validate` 校验通过，`rules explain team <类型>` 确认 `issues.opened` 和 `work.rejected` 派给「编码」，`work.ready` 派给「验收」。两个 Skill 和 `PROJECT.md` 还没写，没有真跑过：

   ```json
   {
     "sources": { "team": { "name": "团队内部" } },
     "agents": {
       "poller": {
         "name": "Issue 轮询",
         "worker": "mac-mini",
         "use": "command",
         "command": ["/Users/me/agent-autoloop/examples/watch-github-issues.sh", "owner/repo", "label:agent"]
       },
       "coder": { "name": "编码", "worker": "mac-mini", "use": "claude", "model": "…", "access": "edit" },
       "verifier": { "name": "验收", "worker": "mac-mini", "use": "codex", "model": "…", "access": "full" }
     },
     "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } },
     "rules": [
       {
         "name": "收 issue",
         "when": { "cron": "*/5 * * * *" },
         "to": "poller",
         "cwd": "~/code/app",
         "tell": "never",
         "emits": { "source": "team", "types": ["issues.opened"] }
       },
       {
         "name": "编码",
         "when": { "source": "team", "types": ["issues.opened", "work.rejected"] },
         "to": "coder",
         "cwd": "~/code/app",
         "skill": "build-with-evidence",
         "parallel": 2,
         "resume": true,
         "emits": { "source": "team", "types": ["work.ready"] }
       },
       {
         "name": "验收",
         "when": { "source": "team", "types": ["work.ready"] },
         "to": "verifier",
         "cwd": "~/code/app-acceptance",
         "skill": "acceptance",
         "parallel": 2,
         "emits": { "source": "team", "types": ["work.rejected"] },
         "channels": ["feishu"]
       }
     ]
   }
   ```

   **安全注意**：验收要起产品、开浏览器、打标签，Codex 的 `edit` 档默认不能联网，所以这里给的是 `full`。`full` 没有系统隔离，“只读”也不代表读不到密钥，验收 Agent 要放在专用系统账号或容器里跑，不放你的密钥。公开仓库谁都能开 issue，issue 内容会经编码 Agent 变成代码，再由验收 Agent 运行，所以只接维护者打过标签的 issue（草稿里的 `label:agent`；GitHub 上给 issue 加标签要 Triage 以上权限，但 issue 模板能替任何人自动加标签，别在模板里自动加这个标签）。`command` 的参数不经过 shell，路径要写绝对路径，`~` 不会展开。

2. **把“测试不算验收、没证据就判不确定”写进现有编码 Skill 的回执约定**：交 `done` 时没附证据就当没做完。几乎不花成本。

3. **踩坑记录**：验收 Agent 把打回的项追加到项目里的一个文件，编码 Skill 开工先读。对应文章说的“下一轮先自查历史踩坑点”，也对应 Acceptance 的 living logs。

4. **规划和执行模型分开（T-1149 同款，现在就能做）**：配一个 `planner`（强模型，`access: "read"`）和一个 `coder`（执行模型，`access: "edit"`）；规划规则用 `emits` 发子任务事件，编码规则接。交给谁仍然由规则决定，规划 Agent 只能“建议做什么”。

5. **Agent Vent 配方**：每天定时跑一条规则，读 `/v1/stream` 或 `status` 里没跑成的轮次和原因，聚类后在回执 `events` 里开修复事项，或者开 GitHub issue 走第 1 条的回环。只是配方，不碰内核。

6. **保持现有的评论边界**：LobeHub 只让成员和 Codex 机器人的评论变成 Agent 的输入，我们的交付插件干脆不向 GitHub 发评论、也不把评论当指令，比它更严，保持就好。

**不建议借**：

- 让主管 Agent 动态决定交给谁、在哪个目录、用什么权限：违反协议原则 6“规则才是指令”。主管 Agent 可以发“建议的子任务事件”，派给谁仍由规则定。
- 把任务依赖图做进内核：内核只收、只分、只派、只记；依赖用回执 `events` 串起来就够了。真要做，先改协议。
- 接 `lh` 或 LobeHub 托管的验收页，以及不加隔离的验收方式（理由见 4.5）。

## 7. 来源

- 文章：<https://mp.weixin.qq.com/s/77RKieFLjZ1gPNU6PSD2yA>（2026-11-09 用移动端 UA 抓取正文）
- PR #21852：<https://github.com/lobehub/lobehub/pull/21852>（`gh pr view` 亲自核对过作者、分支、合并人、合并时间和正文）
- lobehub/lobehub：<https://github.com/lobehub/lobehub>，文中路径对应 `4e48d81f`；许可：<https://github.com/lobehub/lobehub/blob/canary/LICENSE>
- LobeHub 文档：[GitHub 集成](https://lobehub.com/docs/usage/integrations/github)、[外部 Agent](https://lobehub.com/docs/usage/agent/connect-external-agents)、[Agent Groups](https://lobehub.com/docs/usage/agent/agent-team)
- lobehub/acceptance：<https://github.com/lobehub/acceptance>，文中路径对应 `f720feb`（亲自核对过许可证、stars、创建和最后推送时间，以及 `SKILL.md` 第 19、29、232 行）
- 本仓库：`docs/protocol.md`（规则、回执、`hops`、交付插件）、`docs/plugins.md`（`access` 实际能做什么）、`examples/watch-github-issues.sh`

## 核实不了的

- Nasa、Dario 在 LobeHub 内部的真实身份，T-1149 的原文和验收标准，“人只在终审介入”是不是常态。
- 验收报告的实际内容（托管页要登录）。
- LobeHub 裁判和验证 Agent 用什么模型；验证 Agent 的 “isolated thread” 有没有系统级隔离（看起来只是会话级）。
- `@lobehub/cli` 的确切许可。
- 文章列的短板（响应慢、连接出错、要付费）。
- DeepSeek Super-Agent 原型本身。

## Context

按 `docs/f2-plan-2026-11-06.md` 开发。F2 共 5 个包;本会话做 **F2-01 规则编辑体验**(计划建议顺序 F2-01 → F2-02 串行,其余并行,一轮做不完全部)。目标:用户不手改 JSON 也能检查、解释、预览、暂停、恢复、删除规则;暂停不丢活。

计划文档 D1-D3 争议项按文档建议执行:D1 不支持注释、写回前留 `.bak`;D2 暂停的事件规则照常记录/排队、只不派发;D3 暂停的定时规则不补跑。

前置:工作区有阶段 0/1 存量改动(未提交)。先 `npm run test:quick` + `typecheck` + `format:check` 验证存量是绿的,提交为一个 stage-1 提交,再切 `feature/f2-01-rules` 分支做 F2。全部本地提交,不推送。

## 实施步骤(3 个提交,按计划 PR 拆分)

### 提交 0:存量 stage-0/1 改动
验证绿后把当前工作区全部改动提交为一个提交(信息说明是阶段 0/1:备份/更新/限额/指标/重建)。

### 提交 1:`rules validate` + `rules explain`(纯本地,不改内核)
- `protocol/rules.ts`:新函数 `ruleWarnings(rules, known)`(不进 `parseRules`,不阻止生效):通道无 `answerers`(只能发通知)、规则引用的来源还没有密钥(`known.keys`)、规则 `cwd` 在本机不存在(`known.cwdExists`)。
- `cli/rules.ts`(新):`rules validate [文件]`(打印警告)、`rules explain <来源> <事件类型>`、`rules explain <规则名>`(定时规则列接下来 3 次到点,用 `kernel/cron.ts` 的 `nextRun`)。坏文件要能报错不崩(参照 `cli/main.ts` 的 `importRules` 模式)。
- `cli/main.ts`:`rules` 命令接线;`check` 变为 `rules validate` 别名;HELP 更新。
- 测试 `tests/rules-cli.test.ts`(新,先写失败方式):validate 错误与警告;explain 对通配类型、并发组、定时规则的输出;不写文件。

### 提交 2:`disabled` 字段进内核
- `protocol/rules.ts`:规则加可选 `disabled`(布尔);`protocol/schema.json` 的 rules 定义同步。
- `kernel/rules.ts`:`Rule` 类型加 `disabled?: boolean`。
- `kernel/decide.ts`:
  - `claimNext` 可领条件加「规则未暂停」;
  - `tick` 对暂停的定时规则**仍推进 schedules.next_at**但不 enqueue(这样恢复后从下一次到点开始,天然不补,满足 D3);
  - `dropRules` 不变。
- `kernel/state.ts`:`lines` 每项加 `disabled`。
- 测试:
  - `tests/rule-lifecycle.test.ts` 加 4 个用例:暂停的事件规则收 3 条同事项事件→只排一轮不派;恢复后派一次带 3 条事件;暂停的定时规则跨两次到点恢复后不补;暂停期间回答卡片恢复后叫醒原事项。
  - `tests/kernel.test.ts` 或 `tests/schedule.test.ts` 加「暂停后 claimNext 返回 null」——**这条必须能抓变异**。
  - `sim/random.ts`:随机操作加「暂停/恢复一条规则」(改 `rng(12)`→`rng(14)`,新分支切换 disabled 并重放 rules 输入;claimNext 拿到 job 后断言其规则未暂停)。
  - `sim/invariants.ts` 或 random.ts:不变量「暂停中的规则不会有新领取的轮次」。
  - `sim/mutate.ts`:变异清单加一条:去掉 `claimNext` 对 `disabled` 的判断(注意 mutate 只跑 kernel/events/cards/runs/schedule/stream/purity 七个测试,抓变异的测试必须在这些文件里)。
- 文档:CHANGELOG「用了 disabled 后回滚,旧版本会拒绝规则文件,回滚前先 enable 或删字段」+「要注意」;`docs/protocol.md` 规则节;两份 README「这次改了什么」。

### 提交 3:`POST /v1/rules/preview` + 写回类命令
- `kernel/query.ts`:新 `previewRules(view, candidateRules, now, env)`(只读):内部跑 `decide(view, {type:"rules"})` 空跑不提交,归纳为:新增/删除/改名/改动的规则;会被取消的排队轮次(按规则计数,前 20 个编号);会被关闭的卡片(按规则计数,前 20 个编号+标题);已领取的轮次单独列出。
- `kernel/http.ts`:`POST /v1/rules/preview`,只认本人密钥(401);请求体是候选规则 JSON 文本,`parseRules` 校验失败按现有中文错误 400;超限走现有 413。
- `protocol/client.ts`:加 `rulesPreview(body)`。
- `protocol/schema.json`:加 `rules-preview` 请求/响应。
- `cli/rules.ts` 扩展:`rules diff [文件]`、`rules disable|enable <名>`、`rules remove <名>`、`rules edit`(`$EDITOR`)。写回流程固定:校验候选 → 预览 → 确认(非交互必须 `--yes`,否则拒绝)→ 复制 `rules.json.<时间>.bak` → 写临时文件 → 原子改名。
- 测试 `tests/rules-preview.test.ts`(新):删一条有排队轮次+开着卡片的规则,预览结果与真正生效后发生的一致;预览前后事实条数不变;非本人密钥 401;超限 413。`tests/rules-cli.test.ts` 补:disable 后文件只多这一个字段且留备份;非交互无 `--yes` 不写文件;edit 写错的规则不替换原文件。
- 文档:`docs/protocol.md` 本人节加 preview 端点;schema.json;README×2;CHANGELOG;SKILL.md。

## 验证

- 每个提交:`npm run typecheck` + `npm run format:check` + 对应测试文件先红后绿。
- 提交 2(动 kernel/protocol/sim):`npm test` 全量(含 20 万步模拟与穷举)+ `npm run test:nightly`(夜间模拟、强杀、变异;本机空闲内存预算项以与基线一致为准)。
- 提交 3(动 kernel/http、client):`npm run test:quick` 起底,再跑相关测试全量。
- 手工冒烟:临时 `AGENT_AUTOLOOP_HOME` 起中台,走一遍 validate → disable → preview → enable。

## 不做(留到下轮)

F2-02~F2-05、push/建 PR、打版本标签、24 小时 soak。F2-03 的参考客户端在新仓库,不在本仓库动。
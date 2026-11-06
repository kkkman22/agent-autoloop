## Context

按 `docs/f2-plan-2026-11-06.md` 做 **F2-02 路由与审批角色**(F2-01 已完成)。目标:一个中台服务多拨人——规则指定通道、安静时段、紧急程度、回答者角色;旧配置一个字不改(全部新字段可选)。D4-D6 按计划建议:D4 卡片创建时定去向并写在卡片上;D5 系统卡片默认发所有通道,顶层 `notices.channels` 可收;D6 顶层 `roles`,`rules.json` 里 `answerers: ["role:运维"]` 引用。基线:分支 `feature/f2-01-rules` 之上继续,按 PR 拆 3 个本地提交。

## 关键现状(已探明)

- `kernel/decide.ts`:`nextCard` 对所有已登记通道交出所有候选卡片;重试标记(tries/first_try_at)在候选循环里发生 → 安静时段跳过必须放在**标记之前**,否则重试计时提前耗尽。
- 卡片创建:`createCard` 是唯一入口;规则产品卡走 `cardFromReceipt`;系统卡(tell/rulesError/接单程序离线/hops/run 卡)走 `notify`/`tell`。sweep 的离线通知 spec 带 rule 但属于系统卡 → 必须显式传 routing,不能按「有 rule 就按规则路由」。
- `answer` 只核对通道 answerers + 送达 ref;卡片链接回答 by=「链接」不走通道核对(保持现状)。
- 格式指纹:host/fingerprint.ts 把 kernel/schema.sql 哈希进 format → cards 加列自动触发升级首启重建,无需改代码,只写 CHANGELOG。
- 桌面通道:plugins/desktop/channel.ts `show(card.title)`;low 时改为标记 delivered(`skipped-<id>`)不弹。host/channels.ts 的 Card 类型加可选 `severity`。
- 时区处理:内核不读时钟,quiet 判断用 `draft.now` + `draft.rules.timezone`;纯函数 `inQuietHours(quiet, now, zone)` 放 kernel/rules.ts(跨午夜 from>to;Intl formatToParts 取当地分钟,模式照 kernel/cron.ts)。

## 提交 1:规则 `channels` + 顶层 `notices`,卡片记录去向

- `protocol/rules.ts` + `kernel/rules.ts`:规则可选 `channels`(已登记通道列表);顶层可选 `notices: {channels: [...]}`(引用未登记通道报错);`Rules` 类型加 `notices`。
- `kernel/decide.ts`:`DEFAULTS.cards` 加 `channels: null`;`createCard` 接受 `spec.routing`,`cardFromReceipt` 和 `tell=always` 的完成通知按规则算 `routing.channels`(规则没写 = null 即所有通道),其余(tell/rulesError/sweep 离线/hops/run 卡)用 `notices.channels ?? null`;`nextCard` 循环开头:卡片 `channels` 不含该通道 → continue(在任何投递标记之前)。
- 卡片视图/`why`:卡片行带 channels,why 的事实里自然可查。
- 测试:`tests/routing.test.ts`(新,先红):规则指定通道另一通道领不到;不写两通道都领到(旧行为);系统卡按 notices;创建后改规则旧卡片去向不变、新卡片按新规则;`why` 查得到去向。`tests/kernel.test.ts` 加「绑定单通道的卡片不会交到别的通道」(抓变异)。`sim/invariants.ts` 加不变量「卡片只送达给目标通道」;`sim/world.ts` 规则一加 `channels:["chat"]`、加第二通道 bell;`sim/mutate.ts` 加 `route-channel` 变异(去掉 nextCard 通道过滤,须被抓)。
- 文档:protocol.md 通道/规则节、README×2、CHANGELOG(卡片行加列,升级首启重建视图)。

## 提交 2:`severity` + 通道 `quiet`

- `protocol/rules.ts` + `kernel/rules.ts`:规则可选 `severity`(low/normal/urgent,默认 normal);通道可选 `quiet: {from, to}`(HH:MM,from ≠ to,引用 rules.json 时区);`kernel/rules.ts` 新 `inQuietHours(quiet, now, zone)` 纯函数。
- `kernel/decide.ts`:卡片存 severity(DEFAULTS "normal",规则卡取规则);`nextCard`:通道安静时段中且卡片非 urgent → 在投递标记之前 continue(保证放弃计时从第一次真正交出算起;时段结束不主动叫醒长轮询,最晚 50 秒补发——写进协议)。
- `kernel/query.ts` `cardView` 输出加 `severity`;`host/channels.ts` Card 类型加可选 severity;`plugins/desktop/channel.ts`:`severity === "low"` → 不弹通知,标记 delivered。
- `protocol/schema.json` 的 `card` def 加 severity。
- 测试(routing.test.ts + kernel.test.ts):时段内普通卡不交出、urgent 交出;跨午夜;结束后补发;规则时区 ≠ 本机时区按规则时区;安静时段不提前耗尽重试计时;quiet 校验错误(from=to、坏格式)。`tests/desktop.test.ts` 加 low 不弹、normal 照弹。`sim/random.ts` 随机规则带 severity/quiet 场景(用固定时区规则);`sim/mutate.ts` 变异(如去掉 urgent 豁免)可选——不加新变异,由现有用例覆盖。
- 文档:protocol.md(安静时段 + severity + 50 秒补发口径)、README×2、CHANGELOG、schema.json。

## 提交 3:`roles` + 规则 `answerers`

- `protocol/rules.ts` + `kernel/rules.ts`:顶层可选 `roles: {名字: [各通道写法]}`;规则可选 `answerers`(`"role:名字"` 或普通写法;role 引用不存在 → 校验报错);`Rules` 类型加 `roles`。
- `kernel/decide.ts`:卡片创建时把规则的 answerers **展开角色**写进卡片(`answerers: null` = 不额外限制);`answer()`:通道转达的回答在现有两道核对之外,再核对 `card.answerers`(401,原因写清);本人密钥/链接回答不受限。
- `kernel/query.ts` `cardView` 加 `answerers`?不加——回答者名单属路由细节,不进通道视图(泄漏名单给通道无必要);只进 why 的事实。
- 测试:角色里的人能回答、不在的被拒(401);本人密钥不受限;通道 `["*"]` + 规则有角色 → 以角色为准;改角色不影响已建卡片(展开写在卡上);`rules.json` 校验:引用不存在角色报错。`tests/cards.test.ts` 加通道回答核对用例(抓 `answer-role` 变异);`sim/random.ts` op 9 加角色断言「回答者在卡片允许名单里」;`sim/mutate.ts` 加 `answer-role` 变异。
- 文档:protocol.md(角色)、SECURITY.md 隐私边界(规则级 channels 是「只发给谁」不是加密;本人密钥看得到全部;私人资料用 notices.channels 收)、README×2、CHANGELOG。

## 验证

- 每提交先红后绿;`typecheck` + `format:check` 全绿。
- 三个提交都动 kernel/protocol/sim:`npm test` 全量(20 万步模拟 + 穷举)+ `npm run test:nightly`(模拟/强杀/变异;空闲内存预算项按已知基线 114 MB 口径)。
- `tests/cards.test.ts`、`tests/channels.test.ts` 现有用例一个不改全过(「旧配置不用改」的证明)。
- 手工冒烟:临时 home + 假通道,走「规则 channels 只发指定通道 → quiet 时段压卡 → urgent 豁免 → 角色外回答 401」。

## 不做

F2-03~F2-05、推送/建 PR、打标签。
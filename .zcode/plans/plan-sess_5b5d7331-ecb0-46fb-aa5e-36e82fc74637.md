## Context

按 `docs/f2-plan-2026-11-06.md` 做完剩下的三个包:**F2-03 参考客户端**(本仓库只加 state Schema/测试/文档;客户端本体在新仓库)、**F2-04 插件生态**(清单/兼容/安装记录/SSH 签名/update)、**F2-05 交付抽象**(DeliveryHost 接口 + GitHub/GitLab 双实现)。D7/D8/D9/D10 按计划建议(Git SSH 签名;未签名可装有提示,登记公钥的验签失败拒装;GitLab/glab;客户端新仓库)。继续在 `feature/f2-01-rules` 分支按提交推进,全部本地提交不推送。真机交付 e2e(`--run` 建/删真实仓库)不执行。

## 已探明的关键事实

- F2-04:`host/plugins.ts` 13 行纯名字查找(安装目录优先),`cli/main.ts:534` addPlugin 只 clone;`tests/plugins.test.ts` 断言 7 个内置插件加载+外部优先+路径穿越拒绝——必须照过;`tests/example-plugins.test.ts:164` 有现成「临时 git 仓库当插件源」模式;签名测试需 ssh-keygen + git ≥ 2.34,缺则跳过;`cli/update.ts` 有 0600 写文件和 tag 名正则先例。
- F2-05:`DeliveryIO`(delivery.ts:6)的 `api(path)` 就是现有测试注入的 seam;17 个 GitHub REST 路径模式已被两个探索报告列全;`project.ts/input.ts/review.ts` 已平台中立;唯一进程 spawn 是 github.ts 的 `gh()`;凭证全靠 `gh`/`glab` 各自登录,代码零 token;现有 5 个 `tests/delivery*.test.ts` 的 fake 按 GitHub 路径回答——**一个不改**,让它们的 fake 经过新的 GitHub 翻译层即是「翻译没走样」的证明。
- F2-03:`cardView` 已含 severity/channels;`protocol/schema.json` 是 $defs 集合;Node 24 无内置 JSON Schema 校验器,测试需自带受限子集验证器(只支持我们用到的关键词);新增字段按协议约定客户端必须忽略,所以 schema 对未知字段不封闭(additionalProperties 保持 true,用 required 列稳定字段)。

## 实施步骤(按提交;每个提交先红后绿,typecheck + format 全绿)

### F2-03-a(本仓库)
- `protocol/schema.json` 加 `state` 响应 def:required 覆盖 protocol.md 本人节全部稳定字段(now/timezone/spending/totals/cards/recentCards/sources/lines/disabled/elsewhere/agents/channels/runs/hasMore/nextBefore/unrouted)。
- `tests/state-schema.test.ts`(新):固定种子驱动一段完整业务(ingest→claim→ask→answer→续跑→deliver→tick→sweep),每次 `/v1/state` 响应过 Schema;测试内带 ~40 行受限子集验证器(object/array/integer/string/boolean/null/enum/required/properties/items)。
- `docs/protocol.md` 加「写一个客户端」节:本人密钥只放服务端;`/v1/stream` 用 after/last-event-id 断线续读;哪些字段保证稳定、新增字段客户端必须忽略;不配 CORS,密钥不进浏览器。
- 两份 README「更多文档」提参考客户端(文字,不放未上线的假链接)。

### F2-03-b(新仓库,本地)
- `~/code/agent-autoloop-console`(与主仓同级,`git init`,不推送、不发版):Node 24 无依赖小服务——读本人密钥与中台地址(启动参数/env),静态页展示待回答卡片/最近失败轮次/每规则轮数费用/通道送达放弃/接单程序在线,代理 `/v1/state`,SSE 转发 `/v1/stream`;密钥不进浏览器,所以中台无需 CORS。
- 仓库自带测试:起本仓库临时中台(随机端口、临时 HOME),发一条事件走完提问,断言页面数据出现该卡片。README 写从克隆到看到卡片十分钟内的步骤。

### F2-04-a
- `host/semver.ts`(新,几十行):`satisfies(version, range)`,只支持 `>=a.b.c`、`<a.b.c` 和空格组合。
- `host/plugin-manifest.ts` 或并入 plugins.ts:读校验 `plugin.json`(name 同插件名正则、version 语义版本、provides ⊆ agent/channel/source、engine 可选、description 可选);清单 name 与仓库名不一致报错;共享插件名正则(消除 plugins.ts 与 main.ts 的重复)。
- `cli/plugins.ts`(新):`add <地址> [--ref 版本]`(克隆→清单→engine 对 package.json 版本→写 `~/.agent-autoloop/plugins.lock.json` 0600;不兼容删克隆报错)、`plugins list`(名字/版本/提交/签名人/是否兼容)、`plugins remove <名字>`。
- `cli/main.ts`:HELP + commands 接线;doctor 加插件检查(无清单/未签名/engine 不兼容)。
- `tests/plugins-cli.test.ts`(新,临时 git 源仓库不联网):带清单装上并写记录;engine 不兼容拒装不留目录;`--check`/list 不改东西;名字以 `-` 开头或含 `/` 拒;清单 name 与仓库名不一致报错;`tests/plugins.test.ts` 照过(老插件无清单照常加载)。

### F2-04-b
- 签名(D7/D8):`plugins trust <名字> <公钥文件>` 写 `~/.agent-autoloop/allowed_signers`(0600);`add`/`update` 用 `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=… verify-tag` 验证——登记了的插件必须装/更新到已验签的 tag,没签名或签名人不符拒装拒更新并删克隆,未登记可装但在安装输出和 doctor 里提示未签名。
- `plugins update <名字> [--check]`:拉新版本 tag,取比当前记录版本大的最新语义版本,核对清单/兼容/签名后切换;失败停在原版本;`--check` 不改任何东西。
- `tests/plugins-cli.test.ts` 补签名用例(ssh-keygen 造 key + signed tag;缺 ssh-keygen 或 git < 2.34 时 skip 并写原因)。
- 文档:docs/plugins.md(清单/命令/签名说明,不加会被 example-plugins runBlock 执行的同名 heading)、README、CHANGELOG。

### F2-04-c
- `examples/isolation/`:单独系统账号跑接单程序的 systemd 单元与 launchd 示例(说明 sudo 建账号本人自己做)+ 容器 Dockerfile(官方 Node 24 镜像,只跑 `join` 出来的接单程序)。
- INSTALL.md 加 Windows 一节:WSL2 装 Linux 版,不支持原生 Windows。
- `tests/examples.test.ts` 等现有测试照过;ci-scope 不用改(examples 已在 normal scope)。

### F2-05-a
- `plugins/delivery/host.ts`(新):平台无关 `DeliveryHost` 语义接口——读变更(编号/标题/作者/标签/头提交/基线/fork/merged/draft/autoMerge)、读主分支引用、设置提交状态、读完整检查(required job)与其定义文件、读 Ship 运行、读文件、同步分支、转正式、合并(带头提交条件)、关自动合并、祖先比较、变更文件列表。
- `plugins/delivery/github.ts`:新增 `githubHost(io): DeliveryHost` 纯翻译层(现有 `createIO`/`gh()` 不动);`plugins/delivery/delivery.ts`:`deliver()` 改用 host,**保持接受现有 DeliveryIO 形状参数**——内部按 `settings.host`(github 默认)选翻译层,现有 5 个 delivery 测试 fake 零改动照过。
- `project.ts` 的 `settings()`:`ops/delivery.json` 加可选 `host`(github|gitlab)。

### F2-05-b
- `tests/delivery-hosts.test.ts`(新):同一组场景(受保护路径不自动合并、检查定义与 main 不一致不合并、草稿不放行、提交或 main 变化不合并、合并响应丢失读回、Ship 用合并前 main 的设置)对「假 GitHub REST」io 跑一遍,先证明抽象后行为不变。

### F2-05-c
- `plugins/delivery/gitlab.ts`:`gitlabHost(io)`(glab api 形状,`projects/{repo 斜杠转 %2F}/merge_requests/...`;draft/pipeline/manual/skipped 的 GitLab 语义映射) + GitLab 版 `labelled`/`issue` 给 poll/run 用;`run.ts`/`poll.ts` 按 `settings.host` 分派。
- `tests/delivery-hosts.test.ts` 加假 GitLab 跑同一组场景 + GitLab 特有(草稿/需批准不算可合并;pipeline manual/skipped 不算通过)。
- `plugins/delivery/gitlab-ci.yml` 模板(调同一 `run.ts` 判发布,外部镜像固定摘要);`scripts/delivery-e2e.ts` 加 `--host gitlab`(代码就位,不执行真机)。
- 文档:docs/protocol.md 交付插件节、README×2、CHANGELOG。

## 验证

- 每提交先红后绿 + `typecheck` + `format:check`。
- 动 kernel/protocol/sim 的只有 F2-03-a(schema.json + 测试;不动行为):`npm test` 全量。F2-04/F2-05 在 host/cli/plugins/scripts 层:`npm run test:quick` 起底,相关测试全跑;F2-05 收尾跑一次 `npm test` 全量 + `test:nightly`(以基线口径)。
- 客户端仓库:自己的测试跑绿;主仓 purity/docs-json 不受影响。
- 手工冒烟:F2-04 用临时 HOME + 临时 git 源仓库走 add/list/trust(签名)/update;F2-05 靠参数化测试(真机 e2e 不跑)。

## 不做

推送/发版/打标签;真机 delivery-e2e 执行;F2-03 客户端的部署文档超出 README。
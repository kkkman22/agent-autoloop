# 2026-11-07 合并上游同步 + 定时同步 Action

## 背景
- fork 二开。origin/main 已被上游同步推着走了 103 个提交；本地 main 领先 36 个提交（二开成果）。
- 两边同改 59 个文件；工作区另有 33 个未提交文件（21 个与上游撞）。

## 已批准方案
1. 备份分支 `backup/pre-upstream-merge-2026-11-07` 指向合并前 main。
2. 未提交改动整体 commit 为 WIP（含 docs/plans/fix-2026-11-07.md）。
3. `git merge origin/main`，逐文件解冲突：
   - 本地功能必须留：GitLab 交付（glab 翻译层/DeliveryHost）、插件签名 trust、/v1/state schema、回答角色 answerers、通道安静时段、卡片按规则选通道。
   - 上游能力必须带：Windows 原生支持、worker 回执修复、Skill 续接重载、日志序号状态、收件箱 recipe、企微链接等。
   - kernel/protocol 冲突两边都读语义再合，不整文件选边。
4. 全套验证：`npm test` + `npm run typecheck` + `npm run format:check`（合并涉 kernel/protocol，不能走 test:quick）。
5. 测试过后问用户再 push。
6. 新增 `.github/workflows/sync-upstream.yml`：每日定时 fetch 上游 → 合进 `sync/upstream` 分支 → 开 PR 到 main；不直接推 main。注意 GITHUB_TOKEN 开的 PR 不触发 CI，需要 PAT 的话提醒用户。

## 验收标准
- 备份分支存在且指向合并前 main。（✔ backup/pre-upstream-merge-2026-11-07）
- merge commit 生成，工作区干净。
- 三套检查全绿。（✔ typecheck、format:check、`npm test` 834 项 0 挂，含 20 万步模拟与穷举）
- 本地二开功能对应测试（delivery GitLab 场景表、plugins trust、cards 通道选择等）仍在且过。（✔）
- push 由用户点头后执行。

## 结果记录（2026-11-07）
- 48 个冲突文件全解；schema.sql 随上游删除（视图列改在 host/state.ts 声明，补了本地需要的 token 列）。
- 关键取舍：交付采用「趟内同步 main + 每趟重读设置 + 发现问题记 status 防复审」的上游事故修复，叠加本地受保护路径/检查定义门禁，host 抽象与 GitLab 保留；本地 disabled 与上游 pause/resume/run 并存；备份保留本地实现；update 保留 --check/--rollback/版本 并接上上游 release-following；MCP 保持默认只读；卡片链接过期保持 410；worker 读不懂输出改为上游的「结束即 failed 交回」。
- 行为适配的测试改动都写在上面各条里；纯上游措辞变化的断言跟着改了字样。
- 新增 .github/workflows/sync-upstream.yml（每日定时合上游→sync/upstream 分支→开 PR，不碰 main）与本地 upstream remote。

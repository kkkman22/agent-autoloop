// One pull request from label to live: review, full check, merge, Ship, health. Every step reads the platform's state
// back rather than trusting its own last response, and a failure is left for the hub's retry to pick up where it
// stands. Everything platform-specific is said in the host's words (host.ts); GitHub and GitLab translate.
import { matches, settings, type Live, type Settings } from "./project.ts";
import type { Finding, Reviewed } from "./review.ts";
import { hostFor, type Change, type DeliveryHost } from "./host.ts";

export type DeliveryIO = {
  /** Which platform's REST shapes this io speaks; without the mark it is GitHub, as every older io is. */
  host?: "github" | "gitlab";
  api(path: string, body?: any, method?: string): Promise<any>;
  review(pr: any, config: Settings, main: string): Promise<Reviewed>;
  merge(pr: any, config: Settings): Promise<void>;
  disableAuto(number: number): Promise<void>;
  contains(base: string, head: string): Promise<boolean>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  changedFiles(base: string, head: string): Promise<string[] | null>;
  live(config: Settings): Promise<Live | null>;
  wait(): Promise<void>;
};
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[]; head?: string };

const FINDINGS = "审查发现问题，修复后推新提交才会重审";

export const status = (
  io: DeliveryIO,
  head: string,
  context: string,
  state: string,
  description: string,
  repo?: string,
) => hostFor(io, repo ?? "").status(head, context, state, description);

export async function disableAuto(number: number, io: DeliveryIO, repo?: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await io.disableAuto(number);
    } catch {
      /* A lost mutation response must be read back, not assumed. */
    }
    try {
      // The host's own read-back says autoMerge; a raw GitHub answer says auto_merge. Both mean "still set to merge".
      const read = repo ? await hostFor(io, repo).change(number) : await io.api(`pulls/${number}`);
      if (!(read as any).autoMerge && !(read as any).auto_merge) return;
    } catch {
      /* Known failure: a failed read-back must still confirm cancellation within three attempts. */
    }
    if (attempt < 2) await io.wait();
  }
  throw new Error("无法确认自动合并已关闭");
}

export async function fullCheck(
  head: string,
  config: Settings,
  io: DeliveryIO,
  after = 0,
): Promise<"passed" | "waiting" | "failed"> {
  return hostFor(io, config.repo).checks(config, head, after);
}

export async function waitLive(merged: string, config: Settings, io: DeliveryIO) {
  if (!config.health) return;
  const host = hostFor(io, config.repo);
  for (;;) {
    const covering = [];
    for (const run of await host.shipRuns(config)) if (await io.contains(merged, run.sha)) covering.push(run);
    const live = await io.live(config);
    if (live) {
      for (const run of covering) {
        if (!run.ok) continue;
        const liveHasIt = await io.contains(run.sha, live.sha);
        if (liveHasIt || !(await io.releaseRequired(live.sha, run.sha, config.internal))) return;
      }
      // Live already runs the merged code itself: a failed ship mark behind it can't unship what is out.
      if ((await io.contains(merged, live.sha)) && !(await io.releaseRequired(merged, live.sha, config.internal))) {
        return;
      }
    }
    const newest = covering[0];
    if (newest && !newest.ok) {
      throw new Error("已经合并，发布没有通过；修复发布后重交，不要重复提交代码");
    }
    await io.wait();
  }
}

async function sameCheckDefinition(main: string, head: string, config: Settings, io: DeliveryIO) {
  const host = hostFor(io, config.repo);
  const atMain = await host.checkDefinition(config, main);
  return atMain !== null && atMain === (await host.checkDefinition(config, head));
}

async function clearLabels(number: number, change: Change, host: DeliveryHost) {
  // A retry goes by what's left on. A merged PR only goes on to its release while it has `deliver`; an open one with `deliver`
  // alone is a full delivery, so a review-only one must lose `deliver-review` last or the retry merges it.
  const order = change.merged ? ["deliver-review", "deliver"] : ["deliver", "deliver-review"];
  for (const label of ["deliver-attended", ...order]) {
    if (!change.labels.has(label)) continue;
    try {
      await host.removeLabel(number, label);
    } catch (error) {
      // The platform returned an error after an observed labelled change had already completed Ship; verify the
      // desired state by reading the labels back instead of rethrowing blind.
      if ((await host.change(number)).labels.has(label)) throw error;
    }
  }
}

/** The change once the platform has pulled main into it: a new head that main is now behind. */
async function synced(number: number, head: string, base: string, io: DeliveryIO, host: DeliveryHost) {
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const change = await host.change(number);
    if (change.headSha !== head && (await io.contains(base, change.headSha))) return change;
    if (Date.now() > until) throw new Error("已请求同步 main，15 分钟内没有看到同步后的提交，稍后重试");
    await io.wait();
  }
}

export async function deliver(
  repo: string,
  number: number,
  io: DeliveryIO,
  testLocalHealth = false,
): Promise<Delivered> {
  const host = hostFor(io, repo);
  const reviewOnly = async (
    change: Change,
    summary = "审查通过，未合并或发布",
    findings?: Finding[],
  ): Promise<Delivered> => {
    await host.status(change.headSha, "delivery", "success", summary);
    await clearLabels(number, change, host);
    return { summary, reviewOnly: true, ...(findings && { findings }) };
  };
  const settingsAt = async (commit: string) => {
    const file = await host.fileText(commit, "ops/delivery.json");
    if (file === null) throw new Error("读不到 main 上的 ops/delivery.json");
    const read = settings(JSON.parse(file), testLocalHealth);
    if (read.repo !== repo) throw new Error("main 的 repo 设置与交付仓库不一致");
    return read;
  };
  let change = await host.change(number);
  if (!change.labels.has("deliver") || (!change.merged && change.state !== "open")) {
    return { summary: "没有待交付的标记" };
  }
  if (change.headRepo !== repo || change.baseRef !== "main") throw new Error("只处理本仓库分支到 main 的合并请求");
  if (change.autoMerge) await disableAuto(number, io, repo);
  let main = await host.mainRef();
  let config = await settingsAt(main);
  let head = change.headSha;
  if (!change.merged) {
    // The label stays on after findings, so another event lands here: a second review that misses them would merge the commit.
    // The review status keeps the record, since a failed round writes its error over `delivery`.
    const statuses = await host.statuses(head);
    if (statuses.some((item) => item.context === config.review.status && item.state === "failure")) {
      return { summary: "这个提交审查发现过问题，修复后推新提交才会重审" };
    }
  }
  await host.status(head, "delivery", "pending", "正在审查、检查和核实发布");
  let guarded = false;
  // Sync inside the run: a thrown sync waits out the hub's growing retry backoff while main keeps moving.
  for (let round = 1; !change.merged; round++) {
    main = await host.mainRef();
    if (!(await io.contains(main, head))) {
      await host.syncMain(number, head);
      change = await synced(number, head, main, io, host);
      head = change.headSha;
      await host.status(head, "delivery", "pending", "已同步 main，正在审查、检查和核实发布");
      // The platform syncs with main as it is by then, which may be newer than what was read above: against the older
      // one, those commits would be reviewed as the branch's own.
      main = await host.mainRef();
      if (!(await io.contains(main, head))) {
        if (round < 3) continue;
        throw new Error("main 已前进，稍后重新同步和检查");
      }
    }
    // The settings of the main this round is against: a newer one may add the health check its release has to pass.
    config = await settingsAt(main);
    // What CI and delivery run on lives in main; a PR that changes any of it is delivered only when a person has said
    // so on the PR with deliver-attended.
    const files = await io.changedFiles(main, head);
    guarded = files === null || files.some((file) => matches(file, config.protected));
    if (guarded && !change.labels.has("deliver-attended")) {
      const summary = files === null ? "看不清这次改了什么，等人工交付" : "改动涉及受保护路径，等人工确认交付";
      await host.status(head, "delivery", "failure", summary);
      return reviewOnly(change, summary);
    }
    const reviewed = await io.review(prLike(change), config, main);
    const exempt = Array.isArray(reviewed) ? null : reviewed.exempt;
    const findings = Array.isArray(reviewed) ? reviewed : [];
    const current = await host.change(number);
    if (current.merged) {
      change = current;
      break;
    }
    if (current.headSha !== head) throw new Error("审查期间提交变了，等待重新交付");
    if (findings.length) {
      await host.status(head, "delivery", "failure", FINDINGS);
      // Last: once this stands nothing reviews the commit again, so a failed write must not keep the findings from going out.
      await host.status(head, config.review.status, "failure", FINDINGS);
      return { summary: "审查发现问题，尚未合并", findings, head };
    }
    if (current.labels.has("deliver-review")) {
      if (!exempt) return reviewOnly(current);
      // Asked for after this round let the change through without a review: the next round reviews it.
      continue;
    }
    let after = 0;
    if (current.draft) {
      // Right after going ready the newest run is still a draft one: only a run started by the change can pass.
      after = await host.newestCheck(config, head);
      await host.ready(number);
    }
    for (;;) {
      const state = await host.checks(config, head, after);
      if (state === "failed") throw new Error("完整检查没有通过");
      if (state === "passed") break;
      if ((await host.change(number)).headSha !== head) throw new Error("检查期间提交变了");
      await io.wait();
    }
    change = await host.change(number);
    if (change.headSha !== head) throw new Error("要合并的提交没有经过本轮审查");
    if (change.baseRef !== "main") throw new Error("等待检查期间目标分支改了，只合并到 main");
    if (!change.merged) {
      if (!change.labels.has("deliver")) {
        await host.status(head, "delivery", "success", "交付标记已撤回，未合并或发布");
        return { summary: "交付标记已撤回" };
      }
      if (change.labels.has("deliver-review")) {
        if (!exempt) return reviewOnly(change);
        continue;
      }
      if ((await host.mainRef()) !== main) {
        if (round < 3) continue;
        throw new Error("main 已前进，稍后重新同步和检查");
      }
      // The check that passed may have run the PR's own copy of the definition rather than main's: when the two
      // differ, only a person saying deliver-attended makes it main's definition.
      if (!(await sameCheckDefinition(main, head, config, io)) && !change.labels.has("deliver-attended")) {
        const summary = "检查的定义与 main 不一致，等人工交付";
        await host.status(head, "delivery", "failure", summary);
        return reviewOnly(change, summary);
      }
      // An exempt merge says the project's settings let it through, not that a review passed.
      const passed = exempt ? `${exempt} 写的改动按项目设置免审` : "此提交审查通过";
      const note = guarded ? "；改了受保护路径，由 deliver-attended 人工确认" : "";
      await host.status(head, config.review.status, "success", `${passed}，完整检查通过${note}`);
      try {
        await io.merge(prLike(change), config);
      } catch (error) {
        if (!(await host.change(number)).merged) throw error;
      }
      change = await host.change(number);
      if (!change.merged) throw new Error("尚未确认合并，稍后继续核实");
    }
  }
  const mergedAt = change.mergeCommit;
  if (!mergedAt) throw new Error("合并后没有拿到合并提交，稍后继续核实");
  await waitLive(mergedAt, config, io);
  const summary = config.health ? "已合并、发布成功，健康版本已核实" : "已合并；项目没有线上服务";
  await host.status(change.headSha, "delivery", "success", summary);
  await clearLabels(number, change, host);
  return { summary, merged: mergedAt };
}

/** What the review and merge helpers see: the fields they read off the change, whatever the platform calls them. */
const prLike = (change: Change) => ({
  number: change.number,
  head: { sha: change.headSha },
  user: { login: change.author },
  labels: [...change.labels].map((name) => ({ name })),
});

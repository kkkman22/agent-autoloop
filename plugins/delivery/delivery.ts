// One pull request from label to live: review, full check, merge, Ship, health. Every step reads the platform's state
// back rather than trusting its own last response, and a failure is left for the hub's retry to pick up where it
// stands. Everything platform-specific is said in the host's words (host.ts); GitHub and GitLab translate.
import { matches, settings, type Live, type Settings } from "./project.ts";
import type { Finding } from "./review.ts";
import { hostFor, type Change } from "./host.ts";

export type DeliveryIO = {
  /** Which platform's REST shapes this io speaks; without the mark it is GitHub, as every older io is. */
  host?: "github" | "gitlab";
  api(path: string, body?: any, method?: string): Promise<any>;
  review(pr: any, config: Settings, main: string): Promise<Finding[]>;
  merge(pr: any, config: Settings): Promise<void>;
  disableAuto(number: number): Promise<void>;
  contains(base: string, head: string): Promise<boolean>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  changedFiles(base: string, head: string): Promise<string[] | null>;
  live(config: Settings): Promise<Live | null>;
  wait(): Promise<void>;
};
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[] };

const DELIVER_LABELS = ["deliver", "deliver-attended", "deliver-review"];

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
): Promise<"passed" | "waiting" | "failed"> {
  return hostFor(io, config.repo).checks(config, head);
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

async function clearLabels(number: number, labels: Set<string>, host: ReturnType<typeof hostFor>) {
  for (const label of DELIVER_LABELS) {
    if (!labels.has(label)) continue;
    try {
      await host.removeLabel(number, label);
    } catch (error) {
      // The platform returned an error after an observed labelled change had already completed Ship; verify the
      // desired state by reading the labels back instead of rethrowing blind.
      if ((await host.change(number)).labels.has(label)) throw error;
    }
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
    labels: Set<string>,
    head: string,
    summary: string,
    findings?: Finding[],
  ): Promise<Delivered> => {
    await host.status(head, "delivery", "success", summary);
    await clearLabels(number, labels, host);
    return { summary, reviewOnly: true, ...(findings && { findings }) };
  };
  let change = await host.change(number);
  if (!change.merged && (change.state !== "open" || !change.labels.has("deliver")))
    return { summary: "没有待交付的标记" };
  if (change.headRepo !== repo || change.baseRef !== "main") throw new Error("只处理本仓库分支到 main 的合并请求");
  if (change.autoMerge) await disableAuto(number, io, repo);
  const main = await host.mainRef();
  const file = await host.fileText(main, "ops/delivery.json");
  if (file === null) throw new Error("读不到 main 上的 ops/delivery.json");
  const config = settings(JSON.parse(file), testLocalHealth);
  if (config.repo !== repo) throw new Error("main 的 repo 设置与交付仓库不一致");
  const head = change.headSha;
  await host.status(head, "delivery", "pending", "正在审查、检查和核实发布");
  if (!change.merged) {
    if (!(await io.contains(main, head))) {
      await host.syncMain(number, head);
      throw new Error("已请求同步 main，稍后重新审查同步后的提交");
    }
    // What CI and delivery run on lives in main; a PR that changes any of it is delivered only when a person has said
    // so on the PR with deliver-attended.
    const files = await io.changedFiles(main, head);
    const guarded = files === null || files.some((file) => matches(file, config.protected));
    if (guarded && !change.labels.has("deliver-attended")) {
      const summary = files === null ? "看不清这次改了什么，等人工交付" : "改动涉及受保护路径，等人工确认交付";
      await host.status(head, "delivery", "failure", summary);
      return reviewOnly(change.labels, head, summary);
    }
    const findings = await io.review(prLike(change), config, main);
    const current = await host.change(number);
    if (current.headSha !== head) throw new Error("审查期间提交变了，等待重新交付");
    if (findings.length) {
      await host.status(head, "delivery", "failure", "审查发现问题，修复后重新交付");
      return { summary: "审查发现问题，尚未合并", findings };
    }
    if (current.labels.has("deliver-review")) return reviewOnly(current.labels, head, "审查通过，未合并或发布");
    if (current.draft) await host.ready(number);
    for (;;) {
      const state = await host.checks(config, head);
      if (state === "failed") throw new Error("完整检查没有通过");
      if (state === "passed") break;
      if ((await host.change(number)).headSha !== head) throw new Error("检查期间提交变了");
      await io.wait();
    }
    change = await host.change(number);
    if (change.headSha !== head) throw new Error("要合并的提交没有经过本轮审查");
    if (!change.merged) {
      if ((await host.mainRef()) !== main) throw new Error("main 已前进，稍后重新同步和检查");
      if (!change.labels.has("deliver")) return { summary: "交付标记已撤回" };
      if (change.labels.has("deliver-review")) return reviewOnly(change.labels, head, "审查通过，未合并或发布");
      // The check that passed may have run the PR's own copy of the definition rather than main's: when the two
      // differ, only a person saying deliver-attended makes it main's definition.
      if (!(await sameCheckDefinition(main, head, config, io)) && !change.labels.has("deliver-attended")) {
        const summary = "检查的定义与 main 不一致，等人工交付";
        await host.status(head, "delivery", "failure", summary);
        return reviewOnly(change.labels, head, summary);
      }
      const note = guarded ? "；改了受保护路径，由 deliver-attended 人工确认" : "";
      await host.status(head, config.review.status, "success", `此提交审查通过，完整检查通过${note}`);
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
  await clearLabels(number, change.labels, host);
  return { summary, merged: mergedAt };
}

/** What the review and merge helpers see: the fields they read off the change, whatever the platform calls them. */
const prLike = (change: Change) => ({
  number: change.number,
  head: { sha: change.headSha },
  user: { login: change.author },
});

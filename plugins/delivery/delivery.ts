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
  verifyReview?(pr: any, config: Settings, main: string): Promise<Reviewed>;
  merge(pr: any, config: Settings): Promise<void>;
  enableAuto?(pr: any): Promise<void>;
  disableAuto(number: number): Promise<void>;
  verifyTools?(head: string): Promise<string | null>;
  contains(base: string, head: string): Promise<boolean>;
  prepareShip?(): void | Promise<void>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  changedFiles(base: string, head: string): Promise<string[] | null>;
  live(config: Settings): Promise<Live | null>;
  wait(): Promise<void>;
  now?(): number;
  checkRecovery?: { head: string; after: number };
  reviewStatus?: string;
  report?: DeliveryReport;
};
export type DeliveryPhase =
  | "accepted"
  | "reviewing"
  | "checking"
  | "merging"
  | "shipping"
  | "live"
  | "merged"
  | "reviewed"
  | "returned"
  | "withdrawn"
  | "retrying"
  | "docs_only";
export type DeliveryReport = (
  phase: DeliveryPhase,
  head: string,
  metadata?: { merge?: string; ship?: number; detail?: string },
) => void | Promise<void>;
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[]; head?: string };
/** What the Ship run left live: deployed code, or a release with nothing deployable in it. */
export type Shipped = { phase: "live" | "docs_only"; ship: number; release: string };

export class DeliveryRefusal extends Error {
  readonly head?: string;

  constructor(message: string, head?: string) {
    super(message);
    this.head = head;
  }
}

export class DeliverySuperseded extends Error {}

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
  let cause: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await io.disableAuto(number);
    } catch (error) {
      /* A lost mutation response must be read back, not assumed. */
      cause = error;
    }
    try {
      // The host's own read-back says autoMerge; a raw GitHub answer says auto_merge. Both mean "still set to merge".
      const read = repo ? await hostFor(io, repo).change(number) : await io.api(`pulls/${number}`);
      if (!(read as any).autoMerge && !(read as any).auto_merge) return;
    } catch (error) {
      /* Known failure: a failed read-back must still confirm cancellation within three attempts. */
      cause = error;
    }
    if (attempt < 2) await io.wait();
  }
  throw new Error("无法确认自动合并已关闭", { cause });
}

export async function fullCheck(
  head: string,
  config: Settings,
  io: DeliveryIO,
  after = 0,
): Promise<"passed" | "waiting" | "failed" | "stalled"> {
  return hostFor(io, config.repo).checks(config, head, after);
}

export async function waitLive(
  merged: string,
  config: Settings,
  io: DeliveryIO,
  head?: string,
): Promise<Shipped | undefined> {
  if (!config.health) return;
  const host = hostFor(io, config.repo);
  if (head) await io.report?.("shipping", head, { merge: merged });
  await io.prepareShip?.();
  let ship: number | undefined;
  for (;;) {
    const covering = [];
    for (const run of await host.shipRuns(config)) if (await io.contains(merged, run.sha)) covering.push(run);
    const newest = covering[0];
    if (head && newest && newest.id !== ship) {
      ship = newest.id;
      await io.report?.("shipping", head, { merge: merged, ship });
    }
    const live = await io.live(config);
    if (live) {
      for (const run of covering) {
        if (!run.ok) continue;
        const liveHasIt = await io.contains(run.sha, live.sha);
        if (liveHasIt) return { phase: "live", ship: run.id, release: live.release };
        if (!(await io.releaseRequired(live.sha, run.sha, config.internal)))
          return { phase: "docs_only", ship: run.id, release: live.release };
      }
      // Live already runs the merged code itself: a failed ship mark behind it can't unship what is out.
      if ((await io.contains(merged, live.sha)) && !(await io.releaseRequired(merged, live.sha, config.internal))) {
        return { phase: "live", ship: newest?.id ?? 0, release: live.release };
      }
    }
    if (newest && !newest.ok && newest.completed) {
      throw new DeliveryRefusal(`已经合并，发布没有通过：${newest.url}。修复发布后重交原改动。`, head);
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
    if (change.merged) return change;
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
    await io.report?.("reviewed", change.headSha);
    return { summary, reviewOnly: true, ...(findings && { findings }) };
  };
  const withdrawn = async (head: string): Promise<Delivered> => {
    await host.status(head, "delivery", "success", "交付标记已撤回，未合并或发布");
    await io.report?.("withdrawn", head);
    return { summary: "交付标记已撤回" };
  };
  let change = await host.change(number);
  if (!change.labels.has("deliver") || (!change.merged && change.state !== "open")) {
    return { summary: "没有待交付的标记" };
  }
  if (change.headRepo !== repo || change.baseRef !== "main")
    throw new DeliveryRefusal("只处理本仓库分支到 main 的合并请求", change.headSha);
  if (change.autoMerge) await disableAuto(number, io, repo);
  let head = change.headSha;
  const accept = async () => {
    await host.status(head, "delivery", "pending", "正在审查、检查和核实发布");
    await io.report?.("accepted", head);
  };
  if (io.verifyReview) await accept();
  const settingsAt = async (commit: string) => {
    const file = await host.fileText(commit, "ops/delivery.json");
    if (file === null) throw new Error("读不到 main 上的 ops/delivery.json");
    const read = settings(JSON.parse(file), testLocalHealth);
    if (read.repo !== repo) throw new Error("main 的 repo 设置与交付仓库不一致");
    if (io.reviewStatus) read.review.status = io.reviewStatus;
    return read;
  };
  let main = await host.mainRef();
  let config = await settingsAt(main);
  if (!change.merged && !io.verifyReview) {
    // The label stays on after findings, so another event lands here: a second review that misses them would merge the commit.
    // The review status keeps the record, since a failed round writes its error over `delivery`.
    const statuses = await host.statuses(head);
    if (statuses.some((item) => item.context === config.review.status && item.state === "failure")) {
      return { summary: "这个提交审查发现过问题，修复后推新提交才会重审" };
    }
  }
  if (!io.verifyReview) await accept();
  let guarded = false;
  // Sync inside the run: a thrown sync waits out the hub's growing retry backoff while main keeps moving.
  rounds: for (let round = 1; !change.merged; round++) {
    if (change.conflicts) throw new DeliveryRefusal("改动与 main 有合并冲突，请先解决后重新交付。", head);
    main = await host.mainRef();
    if (!(await io.contains(main, head))) {
      try {
        await host.syncMain(number, head);
      } catch (error) {
        const live = await host.change(number);
        if (!live.merged && live.headSha === head) throw error;
      }
      change = await synced(number, head, main, io, host);
      if (change.merged) break;
      if (!(await io.contains(head, change.headSha)))
        throw new DeliverySuperseded("同步后的分支不包含原来的提交，等待重新交付");
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
    const exempt = !Array.isArray(reviewed) && "exempt" in reviewed ? reviewed.exempt : null;
    const findings = Array.isArray(reviewed) ? reviewed : [];
    const current = await host.change(number);
    if (current.merged) {
      change = current;
      break;
    }
    if (current.headSha !== head) throw new DeliverySuperseded("审查期间提交变了，等待重新交付");
    if (!Array.isArray(reviewed) && "blocked" in reviewed) {
      await host.status(head, config.review.status, "failure", reviewed.blocked);
      throw new DeliveryRefusal(reviewed.blocked, head);
    }
    if (!Array.isArray(reviewed) && "changed" in reviewed) {
      change = current;
      continue;
    }
    if (findings.length) {
      await host.status(head, "delivery", "failure", FINDINGS);
      // Last: once this stands nothing reviews the commit again, so a failed write must not keep the findings from going out.
      await host.status(head, config.review.status, "failure", FINDINGS);
      return { summary: "审查发现问题，尚未合并", findings, head };
    }
    if (current.labels.has("deliver-review")) {
      if (!exempt && !io.verifyReview) return reviewOnly(current);
      // Asked for after this round let the change through without a review: the next round reviews it.
      change = current;
      continue;
    }
    await io.report?.("checking", head);
    let after = io.checkRecovery?.head === head ? io.checkRecovery.after : 0;
    if (current.draft) {
      // Right after going ready the newest run is still a draft one: only a run started by the change can pass.
      after = await host.newestCheck(config, head);
      if (io.checkRecovery?.head === head) io.checkRecovery.after = after;
      await host.ready(number);
    }
    let merging = false;
    let autoRequested = false;
    let autoOn = current.autoMerge;
    const stopAuto = async () => {
      if (autoOn || autoRequested) {
        await disableAuto(number, io, repo);
        autoOn = false;
        autoRequested = false;
      }
    };
    try {
      for (;;) {
        const state = await host.checks(config, head, after);
        change = await host.change(number);
        autoOn = change.autoMerge;
        if (change.merged) break rounds;
        if (change.headSha !== head) {
          throw new DeliverySuperseded("检查期间提交变了，等待重新交付");
        }
        if (change.baseRef !== "main" || change.state !== "open") {
          throw new DeliveryRefusal("改动已关闭或目标分支已变更，只合并到 main。", head);
        }
        if (change.conflicts) {
          throw new DeliveryRefusal("改动与 main 有合并冲突，请先解决后重新交付。", head);
        }
        if (!change.labels.has("deliver")) {
          await stopAuto();
          return withdrawn(head);
        }
        if (change.labels.has("deliver-review")) {
          await stopAuto();
          if (!exempt && !io.verifyReview) return reviewOnly(change);
          continue rounds;
        }
        if (state === "stalled") {
          if (io.checkRecovery?.head === head)
            throw new DeliveryRefusal(
              "GitHub 收下了检查却一直没开始跑（多半是 GitHub 出了事故），已重新触发一次仍不动。等 GitHub 恢复后重新交付。",
              head,
            );
          await stopAuto();
          await host.draft(number);
          io.checkRecovery = { head, after };
          // Converting to draft can start another run. Only a run created after going ready can authorize merging.
          after = await host.newestCheck(config, head);
          io.checkRecovery.after = after;
          await host.ready(number);
          continue;
        }
        if (state === "failed") {
          throw new DeliveryRefusal(`完整检查没有通过。查看 ${change.url}/checks`, head);
        }
        if (state === "passed" || change.autoMerge) {
          if ((await host.mainRef()) !== main) {
            await stopAuto();
            if (round < 3) continue rounds;
            throw new Error("main 已前进，稍后重新同步和检查");
          }
          const behind = await io.verifyTools?.(head);
          if (behind) throw new DeliveryRefusal(behind, head);
          const verified = await io.verifyReview?.(prLike(change), config, main);
          if (verified) {
            if (!Array.isArray(verified) && "blocked" in verified) {
              await stopAuto();
              await host.status(head, config.review.status, "failure", verified.blocked);
              throw new DeliveryRefusal(verified.blocked, head);
            }
            const recheckedExempt = !Array.isArray(verified) && "exempt" in verified ? verified.exempt : null;
            if ((!Array.isArray(verified) && "changed" in verified) || recheckedExempt !== exempt) {
              await stopAuto();
              continue rounds;
            }
          }
          if (state === "passed" && !change.autoMerge) {
            const checked = change;
            change = await host.change(number);
            if (change.merged) break rounds;
            if (change.headSha !== head) throw new DeliverySuperseded("要合并的提交变了，等待重新交付");
            if (change.baseRef !== "main" || change.state !== "open") {
              throw new DeliveryRefusal("改动已关闭或目标分支已变更，只合并到 main。", head);
            }
            if (!change.labels.has("deliver")) {
              await stopAuto();
              return withdrawn(head);
            }
            if (change.body !== checked.body || change.labels.has("deliver-review") || change.autoMerge) {
              await stopAuto();
              continue rounds;
            }
            // The check that passed may have run the change's own copy of the definition rather than main's: when the two
            // differ, only a person saying deliver-attended makes it main's definition.
            if (!(await sameCheckDefinition(main, head, config, io)) && !change.labels.has("deliver-attended")) {
              const summary = "检查的定义与 main 不一致，等人工交付";
              await host.status(head, "delivery", "failure", summary);
              return reviewOnly(change, summary);
            }
            // An exempt merge says the project's settings let it through, not that a review passed.
            const passed = exempt
              ? `${exempt} 写的改动按策略免审`
              : !Array.isArray(reviewed) && "docsOnly" in reviewed
                ? "只改内部文档，按策略免审"
                : "此提交审查通过";
            const note = guarded ? "；改了受保护路径，由 deliver-attended 人工确认" : "";
            await host.status(head, config.review.status, "success", `${passed}，完整检查通过${note}`);
            if (!merging) await io.report?.("merging", head);
            merging = true;
            const auto = io.enableAuto && !config.admin_merge.includes(change.author) ? io.enableAuto : undefined;
            try {
              if (auto) {
                autoRequested = true;
                await auto(prLike(change));
              } else await io.merge(prLike(change), config);
            } catch (error) {
              // The request can be accepted before its response is lost. Read back before any retry.
              const afterRequest = await host.change(number);
              if (!afterRequest.merged && !(auto && afterRequest.autoMerge)) throw error;
            }
            change = await host.change(number);
            if (change.merged) break rounds;
            if (!auto || !change.autoMerge) throw new Error("尚未确认合并，稍后继续核实");
          }
        }
        await io.wait();
      }
    } catch (error) {
      await stopAuto();
      throw error;
    }
  }
  const mergedAt = change.mergeCommit;
  if (!mergedAt) throw new Error("合并后没有拿到合并提交，稍后继续核实");
  const shipped = await waitLive(mergedAt, config, io, change.headSha);
  const summary = !shipped
    ? "已合并；项目没有线上服务"
    : shipped.phase === "docs_only"
      ? `仅内部文档变化，已合并，无需发布。已核实线上版本 ${shipped.release}`
      : `已发布并核实线上版本 ${shipped.release}`;
  await host.status(change.headSha, "delivery", "success", summary);
  await clearLabels(number, change, host);
  await io.report?.(shipped?.phase ?? "merged", change.headSha, { merge: mergedAt, ship: shipped?.ship });
  return { summary, merged: mergedAt };
}

/** What the review and merge helpers see: the fields they read off the change, whatever the platform calls them. */
const prLike = (change: Change) => ({
  number: change.number,
  head: { sha: change.headSha },
  user: { login: change.author },
  labels: [...change.labels].map((name) => ({ name })),
  body: change.body,
  url: change.url,
});

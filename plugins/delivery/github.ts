// The delivery's way to GitHub: the signed-in `gh`, and bare Git objects fetched into a scratch folder.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { DeliveryIO, DeliveryReport } from "./delivery.ts";
import type { Change, DeliveryHost } from "./host.ts";
import { changedFiles, git, liveRelease, releaseRequired, REPO, type Settings } from "./project.ts";
import { readSharedPolicy, reviewDelivery } from "./review.ts";

const LONGEST_WAIT = 1800000;
class GitHubHiccup extends Error {}
export function isGitHubHiccup(error: unknown): boolean {
  return error instanceof GitHubHiccup || (error instanceof Error && !!error.cause && isGitHubHiccup(error.cause));
}

export type DeliveryOptions = {
  autoMerge?: boolean;
  toolkit?: string;
  reviewPolicy?: string;
  reviewStatus?: string;
  report?: DeliveryReport;
};

export function gh(args: string[], input?: object) {
  const stdin = input === undefined ? undefined : JSON.stringify(input);
  try {
    return execFileSync("gh", args, {
      input: stdin,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    if (stderr && /\bHTTP 5\d\d\b|Something went wrong while executing your query/.test(stderr))
      throw new GitHubHiccup(stderr);
    throw error;
  }
}

export function github(repo: string) {
  if (!REPO.test(repo)) throw new Error("仓库要写成 owner/name");
  return async (path: string, body?: any, method = body === undefined ? "GET" : "POST") => {
    const ready = /^pulls\/(\d+)\/ready$/.exec(path);
    if (ready) {
      gh(["pr", "ready", ready[1], "--repo", repo]);
      return {};
    }
    const text = gh(
      ["api", `repos/${repo}/${path}`, "--method", method, ...(body === undefined ? [] : ["--input", "-"])],
      body,
    );
    return text ? JSON.parse(text) : {};
  };
}

export function pages(repo: string, path: string): any[] {
  if (!REPO.test(repo)) throw new Error("仓库要写成 owner/name");
  return JSON.parse(gh(["api", `repos/${repo}/${path}`, "--paginate", "--slurp"])).flat();
}

const labels = (pr: any) => new Set<string>((pr.labels ?? []).map((label: any) => label.name));

/** GitHub's REST dialect, spoken once: the host's words go in, the repo's paths come out. */
export function githubHost(repo: string, io: Pick<DeliveryIO, "api">): DeliveryHost {
  const contents = async (ref: string, path: string) => {
    try {
      return await io.api(`contents/${path}?ref=${ref}`);
    } catch (error) {
      // A missing file or blob reads as null, like the host interface says; anything else (502, say) is the platform
      // failing, and swallowing it here would turn an outage into "no settings on main".
      if (/404|not found/i.test(String((error as Error).message))) return null;
      throw error;
    }
  };
  // Only the change's own pull_request run is its check: a workflow_dispatch of the same commit is somebody else's doing.
  const newestRun = async (config: Settings, head: string) => {
    const query = `head_sha=${head}&event=pull_request&per_page=100`;
    const { workflow_runs: runs } = await io.api(`actions/workflows/${config.check.workflow}/runs?${query}`);
    return runs
      .filter((one: any) => one.head_sha === head && one.event === "pull_request")
      .sort((a: any, b: any) => b.id - a.id)[0];
  };
  return {
    async change(number) {
      const pr = await io.api(`pulls/${number}`);
      const change: Change = {
        number,
        state: pr.state,
        merged: Boolean(pr.merged_at),
        labels: labels(pr),
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        headRepo: pr.head.repo?.full_name ?? null,
        autoMerge: Boolean(pr.auto_merge),
        draft: Boolean(pr.draft),
        author: pr.user?.login ?? "",
        mergeCommit: pr.merge_commit_sha ?? null,
        url: pr.html_url ?? "",
        conflicts: pr.mergeable === false || pr.mergeable_state === "dirty",
        body: pr.body ?? null,
      };
      return change;
    },
    async status(head, context, state, description) {
      await io.api(
        `statuses/${head}`,
        { state, context, description: [...description].slice(0, 140).join("") },
        "POST",
      );
    },
    async removeLabel(number, label) {
      await io.api(`issues/${number}/labels/${label}`, undefined, "DELETE");
    },
    async mainRef() {
      return (await io.api("git/ref/heads/main")).object.sha;
    },
    async fileText(ref, path) {
      const file = await contents(ref, path);
      return file ? Buffer.from(file.content, "base64").toString("utf8") : null;
    },
    async checkDefinition(config, ref) {
      return (await contents(ref, `.github/workflows/${config.check.workflow}`))?.sha ?? null;
    },
    async syncMain(number, expectedHead) {
      await io.api(`pulls/${number}/update-branch`, { expected_head_sha: expectedHead }, "PUT");
    },
    async ready(number) {
      await io.api(`pulls/${number}/ready`, {}, "POST");
    },
    async statuses(head) {
      const { statuses } = await io.api(`commits/${head}/status?per_page=100`);
      return statuses.map((item: any) => ({ context: item.context, state: item.state }));
    },
    async newestCheck(config, head) {
      return (await newestRun(config, head))?.id ?? 0;
    },
    async checks(config: Settings, head, after = 0) {
      const { job } = config.check;
      const run = await newestRun(config, head);
      if (!run || run.id <= after) return "waiting";
      const jobs = (await io.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs.filter(
        (candidate: any) => candidate.name === job || candidate.name.startsWith(`${job} (`),
      );
      if (!jobs.length) return "waiting";
      if (run.status === "completed" && run.conclusion !== "success") return "failed";
      const finished = (item: any) => item.status === "completed" && item.conclusion === "success";
      return finished(run) && jobs.every(finished) ? "passed" : "waiting";
    },
    async shipRuns(config) {
      const { workflow_runs } = await io.api(
        `actions/workflows/${config.ship.workflow}/runs?branch=main&event=push&per_page=100`,
      );
      return workflow_runs
        .filter((run: any) => run.event === "push")
        .sort((a: any, b: any) => b.id - a.id)
        .map((run: any) => ({
          id: run.id,
          url: run.html_url,
          sha: run.head_sha,
          completed: run.status === "completed",
          ok: run.status === "completed" && run.conclusion === "success",
        }));
    },
  };
}

const commitSha = /^[a-f0-9]{40}$/;
const commitPrefix = /^[a-f0-9]{7,40}$/;

function decoded(file: { content: string }) {
  return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
}

export function createIO(repo: string, folder: string, options: DeliveryOptions = {}): DeliveryIO {
  const api = github(repo);
  const bare = join(folder, "objects.git");
  const started = Date.now();
  let initialized = false;
  const fetched = new Set<string>();
  const localCommit = (sha: string) => {
    if (!initialized || !commitPrefix.test(sha)) return;
    try {
      return git(bare, "rev-parse", "--verify", `${sha}^{commit}`);
    } catch (error) {
      if ((error as { status?: number }).status !== 128) throw error;
    }
  };
  const fetchObjects = (...refs: string[]) => {
    if (!initialized) {
      mkdirSync(bare, { recursive: true });
      git(bare, "init", "--bare", "--template=");
      git(bare, "config", "remote.origin.url", `https://github.com/${repo}.git`);
      initialized = true;
    }
    const missing = refs.filter((ref) => !commitSha.test(ref) || (!fetched.has(ref) && !localCommit(ref)));
    if (missing.length) {
      git(bare, "fetch", "--no-tags", "origin", ...missing);
      missing.filter((ref) => commitSha.test(ref)).forEach((ref) => fetched.add(ref));
    }
  };
  const ancestors = new Map<string, boolean>();
  let reviewer: number | undefined;
  const review: NonNullable<DeliveryIO["review"]> = (pr, config, main) => checkReview(pr, config, main, false);
  const verifyReview: NonNullable<DeliveryIO["verifyReview"]> = (pr, config, main) =>
    checkReview(pr, config, main, true);
  async function checkReview(pr: any, config: Parameters<DeliveryIO["review"]>[1], main: string, verifyOnly: boolean) {
    fetchObjects(main, pr.head.sha);
    const policy = options.reviewPolicy ? await readSharedPolicy(options.reviewPolicy, github) : undefined;
    return reviewDelivery(bare, join(folder, `review-${pr.head.sha}`), main, pr, config, {
      api,
      statuses: (sha) => pages(repo, `commits/${sha}/statuses?per_page=100`),
      policy,
      reviewerId: () => (reviewer ??= Number(gh(["api", "user", "--jq", ".id"]))),
      verifyOnly,
      onReview: () => options.report?.("reviewing", pr.head.sha),
    });
  }
  const kit = options.toolkit && options.toolkit.toLowerCase() !== repo.toLowerCase() ? github(options.toolkit) : null;
  return {
    api,
    review,
    verifyReview,
    reviewStatus: options.reviewStatus,
    report: options.report,
    ...(options.autoMerge && {
      async enableAuto(pr: any) {
        gh([
          "pr",
          "merge",
          String(pr.number),
          "--repo",
          repo,
          "--auto",
          "--squash",
          "--match-head-commit",
          pr.head.sha,
        ]);
      },
    }),
    ...(kit && {
      async verifyTools(head: string) {
        const installed = decoded(await api(`contents/ops/delivery/kit.json?ref=${head}`)).kit;
        const main = (await kit("git/ref/heads/main")).object.sha;
        const latest = (await kit(`commits?sha=${main}&path=delivery&per_page=1`))[0]?.sha;
        if (!commitSha.test(installed ?? "") || !commitSha.test(latest ?? ""))
          throw new Error("无法识别项目安装的交付工具或工具仓库 main 上的版本");
        const includes = async (base: string, head: string) =>
          base === head || ["ahead", "identical"].includes((await kit(`compare/${base}...${head}`)).status);
        if ((await includes(installed, main)) && (await includes(latest, installed))) return null;
        return `ops/delivery/ 装的是 ${options.toolkit} ${installed.slice(0, 12)}，不是 main 上的最新版（交付工具最近一次改在 ${latest.slice(0, 12)}）。请重新安装并提交后再交付。`;
      },
    }),
    async merge(pr, config) {
      if (config.admin_merge.includes(pr.user.login)) {
        const number = String(pr.number);
        gh(["pr", "merge", number, "--repo", repo, "--squash", "--admin", "--match-head-commit", pr.head.sha]);
        return;
      }
      const result = await api(`pulls/${pr.number}/merge`, { sha: pr.head.sha, merge_method: "squash" }, "PUT");
      if (!result.merged) throw new Error("GitHub 没有接受合并");
    },
    async disableAuto(number) {
      gh(["pr", "merge", String(number), "--repo", repo, "--disable-auto"]);
    },
    prepareShip() {
      // Every older Ship run would otherwise consume a compare request, even when the exact merge is already live.
      fetchObjects("refs/heads/main");
    },
    async contains(base, head) {
      if (base === head) return true;
      const key = `${base}:${head}`;
      if (!ancestors.has(key)) {
        if (initialized && commitPrefix.test(base) && commitPrefix.test(head)) {
          try {
            git(bare, "merge-base", "--is-ancestor", base, head);
            ancestors.set(key, true);
            return true;
          } catch (error) {
            const status = (error as { status?: number }).status;
            // All objects in this scratch repository are fetched with their full history.
            if (status === 1) {
              ancestors.set(key, false);
              return false;
            }
            if (status !== 128) throw error;
          }
        }
        const { status } = await api(`compare/${base}...${head}`);
        ancestors.set(key, ["ahead", "identical"].includes(status));
      }
      return ancestors.get(key)!;
    },
    async releaseRequired(base, head, patterns) {
      let full;
      try {
        full = localCommit(base) ?? (base.length < 40 ? (await api(`commits/${base}`)).sha : base);
        fetchObjects(full, head);
      } catch (error) {
        if (isGitHubHiccup(error)) throw error;
        return true;
      }
      return releaseRequired(bare, full, head, patterns);
    },
    async changedFiles(base, head) {
      if (base === head) return [];
      try {
        fetchObjects(base, head);
      } catch {
        return null;
      }
      return changedFiles(bare, base, head);
    },
    live: liveRelease,
    async wait() {
      if (Date.now() - started > LONGEST_WAIT) throw new Error("等待超过半小时，保留远端状态，稍后继续核实");
      await setTimeout(5000);
    },
  };
}

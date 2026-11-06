// The delivery's way to GitHub: the signed-in `gh`, and bare Git objects fetched into a scratch folder.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { DeliveryIO } from "./delivery.ts";
import type { Change, DeliveryHost } from "./host.ts";
import { changedFiles, git, liveRelease, releaseRequired, type Settings } from "./project.ts";
import { reviewSnapshot } from "./review.ts";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const LONGEST_WAIT = 1800000;

export function gh(args: string[], input?: object) {
  const stdin = input === undefined ? undefined : JSON.stringify(input);
  return execFileSync("gh", args, {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
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
    } catch {
      return null; // 404s are answers here: a missing file or blob reads as null, like the host interface says.
    }
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
    async checks(config: Settings, head) {
      const { workflow, job } = config.check;
      const query = `head_sha=${head}&event=pull_request&per_page=100`;
      const { workflow_runs: runs } = await io.api(`actions/workflows/${workflow}/runs?${query}`);
      const run = runs
        .filter((one: any) => one.head_sha === head && one.event === "pull_request")
        .sort((a: any, b: any) => b.id - a.id)[0];
      if (!run) return "waiting";
      const jobs = (await io.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs.filter(
        (candidate: any) => candidate.name === job,
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
        .map((run: any) => ({ sha: run.head_sha, ok: run.status === "completed" && run.conclusion === "success" }));
    },
  };
}

export function createIO(repo: string, folder: string): DeliveryIO {
  const api = github(repo);
  const bare = join(folder, "objects.git");
  const started = Date.now();
  let initialized = false;
  const fetchObjects = (...refs: string[]) => {
    if (!initialized) {
      mkdirSync(bare, { recursive: true });
      git(bare, "init", "--bare", "--template=");
      git(bare, "remote", "add", "origin", `https://github.com/${repo}.git`);
      initialized = true;
    }
    git(bare, "fetch", "--no-tags", "origin", ...refs);
  };
  const ancestors = new Map<string, boolean>();
  return {
    api,
    async review(pr, config, main) {
      fetchObjects(main, pr.head.sha);
      return reviewSnapshot(bare, join(folder, `review-${pr.head.sha}`), main, pr.head.sha, config);
    },
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
    async contains(base, head) {
      if (base === head) return true;
      const key = `${base}:${head}`;
      if (!ancestors.has(key)) {
        const { status } = await api(`compare/${base}...${head}`);
        ancestors.set(key, ["ahead", "identical"].includes(status));
      }
      return ancestors.get(key)!;
    },
    async releaseRequired(base, head, patterns) {
      try {
        fetchObjects(base, head);
      } catch {
        return true;
      }
      return releaseRequired(bare, base, head, patterns);
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

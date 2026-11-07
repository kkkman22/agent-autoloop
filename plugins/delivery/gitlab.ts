// The delivery's way to GitLab: the signed-in `glab`, and bare Git objects fetched into a scratch folder. The REST
// paths below are relative to the project; the api wrapper adds projects/<group%2Fname>/ to each.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { DeliveryIO } from "./delivery.ts";
import type { Change, DeliveryHost } from "./host.ts";
import { changedFiles, git, liveRelease, releaseRequired } from "./project.ts";
import { reviewSnapshot } from "./review.ts";
import { pendingEvents } from "./input.ts";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const LONGEST_WAIT = 1800000;
const DRAFT = /^Draft[:\s]+/;

export function glab(args: string[], input?: object) {
  const stdin = input === undefined ? undefined : JSON.stringify(input);
  return execFileSync("glab", args, {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function gitlabApi(repo: string) {
  if (!REPO.test(repo)) throw new Error("项目要写成 group/name");
  const project = encodeURIComponent(repo);
  return async (path: string, body?: any, method = body === undefined ? "GET" : "POST") => {
    const text = glab(
      ["api", `projects/${project}/${path}`, "--method", method, ...(body === undefined ? [] : ["--input", "-"])],
      body,
    );
    return text ? JSON.parse(text) : {};
  };
}

const labels = (mr: any) =>
  new Set<string>((mr.labels ?? []).map((label: any) => (typeof label === "string" ? label : label.name)));
const isDraft = (mr: any) => mr.draft === true || DRAFT.test(mr.title ?? "");
const toGitlabStatus = (state: string) =>
  state === "success" ? "success" : state === "failure" ? "failed" : "running";
const fromGitlabStatus = (status: string) =>
  status === "success" ? "success" : status === "failed" ? "failure" : "pending";

/** GitLab's REST dialect, spoken once: the host's words go in, the project's paths come out. */
export function gitlabHost(repo: string, io: Pick<DeliveryIO, "api">): DeliveryHost {
  void repo;
  const fileAt = async (ref: string, path: string) => {
    try {
      return await io.api(`repository/files/${Buffer.from(path).toString("base64url")}?ref=${encodeURIComponent(ref)}`);
    } catch (error) {
      // A missing file is an answer here, like the host interface says; other failures must reach the round's caller.
      if (/404|not found/i.test(String((error as Error).message))) return null;
      throw error;
    }
  };
  // Only the merge request's own pipeline is the full check: with the same sha, an api- or trigger-run of it is
  // somebody's own doing, not the change's.
  const newestPipeline = async (head: string) => {
    const pipelines = await io.api(`pipelines?sha=${encodeURIComponent(head)}&source=merge_request`);
    return [...pipelines].sort((a: any, b: any) => b.id - a.id)[0];
  };
  return {
    async change(number) {
      const mr = await io.api(`merge_requests/${number}`);
      const change: Change = {
        number,
        state: mr.state === "opened" ? "open" : mr.state,
        merged: Boolean(mr.merged_at),
        labels: labels(mr),
        headSha: mr.sha,
        baseRef: mr.target_branch,
        headRepo: mr.source_project?.path_with_namespace ?? null,
        autoMerge: Boolean(mr.auto_merge),
        draft: isDraft(mr),
        author: mr.author?.username ?? "",
        mergeCommit: mr.merge_commit_sha ?? null,
      };
      return change;
    },
    async status(head, context, state, description) {
      await io.api(
        `statuses/${head}`,
        { state: toGitlabStatus(state), name: context, description: [...description].slice(0, 140).join("") },
        "POST",
      );
    },
    async removeLabel(number, label) {
      await io.api(`merge_requests/${number}/labels`, { remove_labels: label }, "PUT");
    },
    async mainRef() {
      return (await io.api(`repository/branches/main`)).commit.id;
    },
    async fileText(ref, path) {
      const found = await fileAt(ref, path);
      return found ? Buffer.from(found.content, "base64").toString("utf8") : null;
    },
    async checkDefinition(config, ref) {
      void config; // on GitLab every project's check is its .gitlab-ci.yml, whatever the settings call it
      const found = await fileAt(ref, ".gitlab-ci.yml");
      return found?.content_sha256 ?? null;
    },
    async syncMain(number, expectedHead) {
      await io.api(`merge_requests/${number}/rebase`, { expected_head_sha: expectedHead }, "PUT");
    },
    async ready(number) {
      // GitLab has no ready button: a draft is a title, so un-drafting is editing the title.
      const mr = await io.api(`merge_requests/${number}`);
      const stripped = (mr.title ?? "").replace(DRAFT, "");
      if (stripped !== mr.title) await io.api(`merge_requests/${number}`, { title: stripped }, "PUT");
    },
    async statuses(head) {
      const items = await io.api(`repository/commits/${encodeURIComponent(head)}/statuses`);
      return [...items].map((item: any) => ({ context: item.name, state: fromGitlabStatus(item.status) }));
    },
    async newestCheck(_config, head) {
      return (await newestPipeline(head))?.id ?? 0;
    },
    async checks(_config, head, after = 0) {
      // Manual and skipped are waits, never a pass.
      const newest = await newestPipeline(head);
      if (!newest || newest.id <= after) return "waiting";
      if (newest.status === "success") return "passed";
      if (newest.status === "failed") return "failed";
      return "waiting";
    },
    async shipRuns(_config) {
      const pipelines = await io.api(`pipelines?ref=main&source=push`);
      return [...pipelines]
        .sort((a: any, b: any) => b.id - a.id)
        .filter((pipeline: any) => pipeline.status === "success" || pipeline.status === "failed")
        .map((pipeline: any) => ({ sha: pipeline.sha, ok: pipeline.status === "success" }));
    },
  };
}

export function createIO(repo: string, folder: string): DeliveryIO {
  const api = gitlabApi(repo);
  const bare = join(folder, "objects.git");
  const started = Date.now();
  let initialized = false;
  const fetchObjects = (...refs: string[]) => {
    if (!initialized) {
      mkdirSync(bare, { recursive: true });
      git(bare, "init", "--bare", "--template=");
      git(bare, "remote", "add", "origin", `https://gitlab.com/${repo}.git`);
      initialized = true;
    }
    git(bare, "fetch", "--no-tags", "origin", ...refs);
  };
  const isAncestor = (base: string, head: string) =>
    spawnSync("git", ["-C", bare, "merge-base", "--is-ancestor", head, base]).status === 0;
  const ancestors = new Map<string, boolean>();
  return {
    host: "gitlab",
    api,
    async review(pr, config, main) {
      fetchObjects(main, pr.head.sha);
      return reviewSnapshot(bare, join(folder, `review-${pr.head.sha}`), main, pr.head.sha, config);
    },
    async merge(pr) {
      // GitLab has no second, higher-privilege merge lane: whoever glab signs in as needs the rights themselves.
      void pr.user;
      await api(`merge_requests/${pr.number}/merge`, { sha: pr.head.sha, squash: true }, "PUT");
    },
    async disableAuto(number) {
      try {
        await api(`merge_requests/${number}/auto_merge`, undefined, "DELETE");
      } catch {
        /* Turning off nothing is done; the delivery reads the change back either way. */
      }
    },
    async contains(base, head) {
      if (base === head) return true;
      const key = `${base}:${head}`;
      if (!ancestors.has(key)) {
        fetchObjects(base, head);
        ancestors.set(key, isAncestor(base, head));
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

/** The labelled issues and merge requests waiting for delivery, with each label event's own stable id. */
export async function gitlabPoll(repo: string) {
  const api = gitlabApi(repo);
  const rows = [];
  for (const label of ["deliver", "ask-owner"]) {
    const items = await api(`issues?state=opened&labels=${encodeURIComponent(label)}`);
    for (const issue of items) {
      const events = await api(`issues/${issue.iid}/resource_label_events`);
      const marked = events.filter((event: any) => event.label?.name === label).at(-1);
      if (!marked) throw new Error(`找不到事项 ${issue.iid} 的标签记录`);
      // Issues and merge requests share one iid sequence; an iid with an MR behind it is a delivery.
      let mr: any = null;
      try {
        mr = await api(`merge_requests/${issue.iid}`);
      } catch {}
      if (mr?.state === "closed" && !mr.merged_at) continue;
      rows.push({
        number: issue.iid,
        head: mr?.sha ?? "",
        labelEvent: marked.id,
        kind: mr ? "pull_request" : "issues",
      });
    }
  }
  return pendingEvents(repo, rows);
}

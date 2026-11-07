// The delivery's rules must hold on any hosting platform, so they are written once and run against each platform's
// REST dialect: protected paths never merge unattended, a check that runs a definition differing from main's is not
// main's, drafts wait for ready, a moved head or main stops the merge, a lost merge answer is read back, and the
// settings a release is judged by come from main before the merge. The fakes at the bottom speak GitHub and GitLab;
// every scenario runs against both, and the last tests hold only what each dialect says in its own words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliver, type DeliveryIO } from "../plugins/delivery/delivery.ts";
import { gitlabHost } from "../plugins/delivery/gitlab.ts";
import type { Settings } from "../plugins/delivery/project.ts";

const REPO = "example/project";
const SETTINGS: Settings = {
  repo: REPO,
  internal: ["internal/**"],
  protected: [".github/**", "scripts/**", "tests/**", "package.json", "ops/delivery.json"],
  admin_merge: [],
  check: { workflow: "check.yml", job: "check" },
  ship: { workflow: "ship.yml" },
  review: { points: "2", xhigh: [], status: "agent-review" },
};

type World = {
  pr: any;
  main: string;
  workflow: Record<string, string>;
  settings: Settings;
  statuses: { sha: string; context: string; state: string }[];
  writes: string[];
  askedSettingsRef: string[];
  merged: boolean;
  reviewed: boolean;
  mergedCalls: number;
  health: { url: string } | undefined;
  /** What the diff between main and the change touches; null means the platform cannot say. */
  files: string[] | null;
  /** GitLab side: the MR's title (a Draft: prefix makes it a draft) and whether the target approves merges. */
  title: string;
  approved: boolean;
  pipelines: { id: number; sha: string; ref?: string; source?: string; status: string }[];
  /** The check the change's own ready run got: only a run past this id can pass for a readied draft. */
  runs: number;
};

function world(over: Partial<World> = {}): World {
  return {
    pr: {
      number: 1,
      state: "open",
      merged_at: null,
      labels: [{ name: "deliver" }],
      head: { sha: "head", repo: { full_name: REPO } },
      base: { ref: "main" },
      draft: false,
      auto_merge: null,
      user: { login: "someone" },
      merge_commit_sha: "merged-commit",
    },
    main: "main-1",
    workflow: { main: "definition", head: "definition" },
    settings: SETTINGS,
    statuses: [],
    writes: [],
    askedSettingsRef: [],
    merged: false,
    reviewed: false,
    mergedCalls: 0,
    health: undefined,
    files: [],
    title: "新功能",
    approved: true,
    pipelines: [{ id: 1, sha: "head", source: "merge_request", status: "success" }],
    runs: 1,
    ...over,
  };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");
const base64url = (text: string) => Buffer.from(text).toString("base64url");

/** A fake that answers the GitHub REST paths the delivery uses, recording what the delivery asked. */
function githubIO(state: World): DeliveryIO {
  return {
    async api(path: string, body: any, method: string) {
      if (path === "pulls/1") return structuredClone(state.pr);
      if (path === "git/ref/heads/main") return { object: { sha: state.main } };
      if (path.startsWith("contents/ops/delivery.json")) {
        state.askedSettingsRef.push(new URLSearchParams(path.split("?")[1]).get("ref")!);
        return { content: b64(JSON.stringify(state.settings)) };
      }
      if (path.startsWith("contents/.github/workflows/")) {
        const ref = new URLSearchParams(path.split("?")[1]).get("ref")!;
        return { sha: state.workflow[ref] ?? "definition" };
      }
      if (path.startsWith("statuses/")) {
        state.statuses.push({ sha: path.split("/")[1], context: body.context, state: body.state });
        return {};
      }
      if (/^commits\/[^/]+\/status/.test(path)) {
        const sha = path.split("/")[1];
        return { statuses: state.statuses.filter((one) => one.sha === sha) };
      }
      if (path.startsWith("actions/workflows/check.yml"))
        return {
          workflow_runs: [
            {
              id: state.runs,
              head_sha: "head",
              event: "pull_request",
              status: "completed",
              conclusion: "success",
            },
          ],
        };
      if (path.startsWith("actions/runs/"))
        return { jobs: [{ name: "check", status: "completed", conclusion: "success" }] };
      if (path.startsWith("actions/workflows/ship.yml")) return { workflow_runs: [] };
      if (path.startsWith("issues/1/labels/")) {
        if (method === "DELETE") {
          state.writes.push(path);
          const label = path.split("/").at(-1)!;
          state.pr.labels = state.pr.labels.filter((one: any) => one.name !== label);
          return {};
        }
      }
      if (path === "pulls/1/merge") {
        state.mergedCalls += 1;
        if (!state.merged) throw new Error("lost merge response");
        state.pr.merged_at = "now";
        return { merged: true };
      }
      if (path === "pulls/1/update-branch") {
        // The platform pulls main in: the branch gets a new head that main is behind.
        state.pr.head.sha = `${state.pr.head.sha}+synced`;
        return {};
      }
      if (path === "pulls/1/ready") {
        state.pr.draft = false;
        // A draft's run stays the newest one until the change itself starts one.
        state.runs += 1;
        return {};
      }
      throw new Error(`unexpected ${path} ${method ?? ""}`);
    },
    host: "github",
    async review() {
      state.reviewed = true;
      return [];
    },
    async merge(pr: any) {
      // The platform is told the head commit it may merge; the world merges only behind that exact commit.
      assert.equal(pr.head.sha, "head");
      state.mergedCalls += 1;
      state.merged = true;
      state.pr.merged_at = "now";
      throw new Error("lost merge response");
    },
    async disableAuto() {},
    async contains(base: string, head: string) {
      // In this world the change sits right on top of whatever main points at, and a merge commit contains itself.
      return base === head || base === state.main || head === "merged-commit";
    },
    async releaseRequired() {
      return true;
    },
    async changedFiles() {
      return structuredClone(state.files);
    },
    async live() {
      return null;
    },
    async wait() {},
  };
}

/** The same world through GitLab's shapes: string labels, an "opened" state, pipelines instead of workflow runs. */
function gitlabIO(state: World): DeliveryIO {
  const isDraft = (mr: any) => mr.draft === true || /^Draft[:\s]+/.test(mr.title ?? "");
  const mr = () => ({
    iid: 1,
    state: state.pr.merged_at ? "merged" : "opened",
    merged_at: state.pr.merged_at,
    labels: state.pr.labels.map((label: any) => label.name),
    sha: state.pr.head.sha,
    target_branch: state.pr.base.ref,
    source_project: { path_with_namespace: state.pr.head.repo.full_name },
    auto_merge: state.pr.auto_merge ? "merge_when_pipeline_succeeds" : null,
    draft: false,
    title: state.title,
    author: { username: state.pr.user.login },
    merge_commit_sha: state.pr.merged_at ? "merged-commit" : null,
  });
  const withDraftTitle = (view: any) => ({ ...view, draft: isDraft(view) });
  return {
    async api(path: string, body: any, method: string) {
      if (path === "merge_requests/1" && method === undefined) return withDraftTitle(structuredClone(mr()));
      if (path === "repository/branches/main") return { commit: { id: state.main } };
      if (path.startsWith("repository/files/")) {
        const ref = new URLSearchParams(path.split("?")[1]).get("ref")!;
        const name = Buffer.from(path.split("?")[0].split("/").at(-1)!, "base64url").toString();
        if (name === "ops/delivery.json") {
          state.askedSettingsRef.push(ref);
          return { content: b64(JSON.stringify(state.settings)), content_sha256: "settings-blob" };
        }
        if (name === ".gitlab-ci.yml")
          return { content: b64("pipeline"), content_sha256: state.workflow[ref] ?? "definition" };
        throw new Error(`404 ${name}`);
      }
      if (path.startsWith("statuses/")) {
        state.statuses.push({ sha: path.split("/")[1], context: body.name, state: body.state });
        return {};
      }
      if (/^repository\/commits\/[^/]+\/statuses$/.test(path)) {
        const sha = path.split("/")[2];
        return state.statuses.filter((one) => one.sha === sha).map((one) => ({ name: one.context, status: one.state }));
      }
      if (path === "merge_requests/1/labels" && method === "PUT") {
        state.writes.push(path);
        const gone = body.remove_labels;
        state.pr.labels = state.pr.labels.filter((one: any) => one.name !== gone);
        return withDraftTitle(mr());
      }
      if (path.startsWith("pipelines?")) {
        // The platform answers what was asked: a sha, a ref, a source, whatever the query says.
        const query = new URLSearchParams(path.split("?")[1]);
        return state.pipelines.filter((pipeline) => {
          if (query.get("sha") && pipeline.sha !== query.get("sha")) return false;
          if (query.get("source") && pipeline.source !== query.get("source")) return false;
          if (query.get("ref") === "main" && !(pipeline.ref === "main" || pipeline.sha === state.main)) return false;
          return true;
        });
      }
      if (path === "merge_requests/1/merge" && method === "PUT") {
        assert.equal(body.sha, "head", "合并必须钉在审查过的那个提交上");
        if (!state.approved) throw new Error("405 Method Not Allowed - not approved");
        state.mergedCalls += 1;
        state.merged = true;
        state.pr.merged_at = "now";
        return withDraftTitle(mr());
      }
      if (path === "merge_requests/1/rebase") {
        // The platform pulls main in: the branch gets a new head that main is behind.
        state.pr.head.sha = `${state.pr.head.sha}+synced`;
        return {};
      }
      if (path === "merge_requests/1" && method === "PUT") {
        if (body.title !== undefined) {
          const wasDraft = isDraft({ title: state.title });
          state.title = body.title;
          // Un-drafting starts the MR's own pipeline; the draft one stays the newest until then.
          if (wasDraft && !isDraft({ title: state.title }))
            state.pipelines.unshift({
              id: (state.pipelines[0]?.id ?? 0) + 1,
              sha: "head",
              source: "merge_request",
              status: "success",
            });
        }
        return withDraftTitle(mr());
      }
      throw new Error(`unexpected ${path} ${method ?? ""}`);
    },
    host: "gitlab",
    async review() {
      state.reviewed = true;
      return [];
    },
    async merge(pr: any) {
      assert.equal(pr.head.sha, "head");
      if (!state.approved) throw new Error("405 Method Not Allowed - not approved");
      state.mergedCalls += 1;
      state.merged = true;
      state.pr.merged_at = "now";
      throw new Error("lost merge response");
    },
    async disableAuto() {},
    async contains(base: string, head: string) {
      return base === head || base === state.main || head === "merged-commit";
    },
    async releaseRequired() {
      return true;
    },
    async changedFiles() {
      return structuredClone(state.files);
    },
    async live() {
      return null;
    },
    async wait() {},
  };
}

const ioOf = (dialect: "github" | "gitlab", state: World) => (dialect === "gitlab" ? gitlabIO(state) : githubIO(state));
const drive = (dialect: "github" | "gitlab", state: World) => deliver(REPO, 1, ioOf(dialect, state));

for (const dialect of ["github", "gitlab"] as const) {
  test(
    `protected paths are never merged without a person's deliver-attended (${dialect})`,
    { timeout: 2000 },
    async () => {
      const unattended = world({ files: ["scripts/build.sh"] });
      const stopped = await drive(dialect, unattended);
      assert.match(stopped.summary, /受保护路径/);
      assert.equal(stopped.reviewOnly, true);
      assert.equal(unattended.mergedCalls, 0, "没人确认就没有合并调用");
      assert.equal(unattended.reviewed, false, "受保护路径不进审查");
      assert.ok(
        unattended.statuses.some((s) => s.state === "failure" || s.state === "failed"),
        "失败写进了交付状态",
      );
      assert.equal(
        unattended.pr.labels.some((l: any) => l.name === "deliver"),
        false,
        "标签清了",
      );

      // With the person's mark on the change, the same protected paths go all the way through.
      const attended = world({
        files: ["scripts/build.sh"],
        pr: { ...world().pr, labels: [{ name: "deliver" }, { name: "deliver-attended" }] },
      });
      const passed = await drive(dialect, attended);
      assert.match(passed.summary, /已合并/);
      assert.equal(attended.merged, true);
    },
  );

  test(
    `a check that runs a definition differing from main's is not main's, unless attended (${dialect})`,
    { timeout: 2000 },
    async () => {
      const mismatched = world();
      mismatched.workflow.head = "pr-own-copy";
      const stopped = await drive(dialect, mismatched);
      assert.match(stopped.summary, /定义与 main 不一致/);
      assert.equal(mismatched.mergedCalls, 0);

      const attended = world({ pr: { ...world().pr, labels: [{ name: "deliver" }, { name: "deliver-attended" }] } });
      attended.workflow.head = "pr-own-copy";
      const passed = await drive(dialect, attended);
      assert.match(passed.summary, /已合并/);
      assert.equal(attended.merged, true);
    },
  );

  test(
    `a draft is readied, not refused, and merges once its check passes (${dialect})`,
    { timeout: 2000 },
    async () => {
      const state = world({ title: "Draft: 新功能", pr: { ...world().pr, draft: true } });
      const result = await drive(dialect, state);
      assert.match(result.summary, /已合并/);
      if (dialect === "github") assert.equal(state.pr.draft, false, "转正了");
      else assert.ok(!/^Draft/.test(state.title), "标题去掉了草稿前缀");
      assert.equal(state.merged, true);
    },
  );

  test(
    `a moved head stops the merge; a moved main has the round carried on against the newer one (${dialect})`,
    { timeout: 2000 },
    async () => {
      // The head is pushed again while the review runs: the attestation no longer matches what is there, nothing merges.
      const moved = world();
      const movedIO = ioOf(dialect, moved);
      const review = movedIO.review.bind(movedIO);
      movedIO.review = async (...args: any[]) => {
        moved.pr.head.sha = "pushed-again";
        return review(...(args as [any, any, string]));
      };
      await assert.rejects(deliver(REPO, 1, movedIO), /审查期间提交变了/);
      assert.equal(moved.mergedCalls, 0);

      // Main advances while the review runs: nothing merges against the older one. The next round reviews against
      // the newer main, reads its settings, and merges there.
      const advanced = world();
      const advancedIO = ioOf(dialect, advanced);
      const review2 = advancedIO.review.bind(advancedIO);
      const seenWith: string[] = [];
      advancedIO.review = async (pr: any, config: any, main: string) => {
        advanced.main = "main-2";
        seenWith.push(main);
        return review2(pr, config, main);
      };
      const result = await deliver(REPO, 1, advancedIO);
      assert.match(result.summary, /已合并/);
      assert.equal(advanced.mergedCalls, 1);
      assert.deepEqual(seenWith, ["main-1", "main-2"], "对着新的 main 重新审查了");
      assert.ok(advanced.askedSettingsRef.includes("main-2"), "设置从新的 main 读");
    },
  );

  test(
    `a lost merge answer is read back, and the merge is never repeated (${dialect})`,
    { timeout: 2000 },
    async () => {
      const state = world();
      state.merged = true; // the platform accepted the merge; the answer was lost on the way back
      const result = await drive(dialect, state);
      assert.match(result.summary, /已合并/);
      assert.equal(state.mergedCalls, 1, "只合并了一次");
    },
  );

  test(
    `the settings a delivery runs by are read from main, and Ship waits for them (${dialect})`,
    { timeout: 2000 },
    async () => {
      const state = world();
      await drive(dialect, state);
      // Settings are read once up front and again for the round's own main; never from anywhere else.
      assert.ok(
        state.askedSettingsRef.length >= 1 && state.askedSettingsRef.every((ref) => ref === state.main),
        "只从 main 读设置",
      );
      assert.equal(state.merged, true);
    },
  );
}

test("a GitLab pipeline that only waits is never a pass, in any of its shapes", async () => {
  const state = world();
  const host = gitlabHost(REPO, {
    api: async (path: string) => {
      if (path.startsWith("pipelines?")) {
        const query = new URLSearchParams(path.split("?")[1]);
        return state.pipelines.filter(
          (pipeline) => pipeline.sha === query.get("sha") && pipeline.source === query.get("source"),
        );
      }
      throw new Error(`unexpected ${path}`);
    },
  } as any);
  for (const status of ["manual", "skipped", "running", "pending", "created"]) {
    state.pipelines = [{ id: 1, sha: "head", source: "merge_request", status }];
    assert.equal(await host.checks(SETTINGS, "head"), "waiting", status);
  }
  state.pipelines = [{ id: 1, sha: "head", source: "merge_request", status: "failed" }];
  assert.equal(await host.checks(SETTINGS, "head"), "failed");
  state.pipelines = [{ id: 1, sha: "head", source: "merge_request", status: "success" }];
  assert.equal(await host.checks(SETTINGS, "head"), "passed");
});

test("a GitLab pipeline the merge request didn't ask for doesn't count as its check", async () => {
  const state = world();
  const host = gitlabHost(REPO, {
    api: async (path: string) => {
      if (path.startsWith("pipelines?")) {
        const query = new URLSearchParams(path.split("?")[1]);
        return state.pipelines.filter(
          (pipeline) => pipeline.sha === query.get("sha") && pipeline.source === query.get("source"),
        );
      }
      throw new Error(`unexpected ${path}`);
    },
  } as any);
  // Somebody's api-triggered run on the same sha, green as it may be, is not the merge request's check.
  state.pipelines = [{ id: 2, sha: "head", source: "api", status: "success" }];
  assert.equal(await host.checks(SETTINGS, "head"), "waiting");
  state.pipelines = [{ id: 3, sha: "head", source: "merge_request", status: "success" }];
  assert.equal(await host.checks(SETTINGS, "head"), "passed");
});

test("a GitLab merge behind a missing approval is refused and reads as not merged", { timeout: 2000 }, async () => {
  const state = world({ approved: false });
  await assert.rejects(drive("gitlab", state), /not approved/);
  assert.equal(state.merged, false);
  assert.equal(
    state.pr.labels.some((l: any) => l.name === "deliver"),
    true,
    "标签还挂着，等重试或人工",
  );
});

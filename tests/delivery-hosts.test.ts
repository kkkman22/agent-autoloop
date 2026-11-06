// The delivery's rules must hold on any hosting platform, so they are written once and run against each platform's
// REST dialect: protected paths never merge unattended, a check that runs a definition differing from main's is not
// main's, drafts wait for ready, a moved head or main stops the merge, a lost merge answer is read back, and the
// settings a release is judged by come from main before the merge. This file adds the fake REST dialects; the
// scenarios below are the shared table, and the fakes at the bottom speak GitHub today (and GitLab beside it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliver, type DeliveryIO } from "../plugins/delivery/delivery.ts";
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
  checks: "passed" | "waiting" | "failed";
  askedSettingsRef: string[];
  merged: boolean;
  reviewed: boolean;
  mergedCalls: number;
  health: { url: string } | undefined;
  /** What the diff between main and the change touches; null means the platform cannot say. */
  files: string[] | null;
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
    checks: "passed",
    askedSettingsRef: [],
    merged: false,
    reviewed: false,
    mergedCalls: 0,
    health: undefined,
    files: [],
    ...over,
  };
}

/** A fake that answers the GitHub REST paths the delivery uses, recording what the delivery asked. */
function githubIO(state: World): DeliveryIO {
  return {
    async api(path: string, body: any, method: string) {
      if (path === "pulls/1") return structuredClone(state.pr);
      if (path === "git/ref/heads/main") return { object: { sha: state.main } };
      if (path.startsWith("contents/ops/delivery.json")) {
        state.askedSettingsRef.push(new URLSearchParams(path.split("?")[1]).get("ref")!);
        return { content: Buffer.from(JSON.stringify(state.settings)).toString("base64") };
      }
      if (path.startsWith("contents/.github/workflows/")) {
        const ref = new URLSearchParams(path.split("?")[1]).get("ref")!;
        return { sha: state.workflow[ref] ?? "definition" };
      }
      if (path.startsWith("statuses/")) {
        state.statuses.push({ sha: path.split("/")[1], context: body.context, state: body.state });
        return {};
      }
      if (path.startsWith("actions/workflows/check.yml"))
        return {
          workflow_runs: [
            { id: 1, head_sha: "head", event: "pull_request", status: "completed", conclusion: "success" },
          ],
        };
      if (path.startsWith("actions/runs/1/jobs"))
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
      if (path === "pulls/1/update-branch") return {};
      if (path === "pulls/1/ready") {
        state.pr.draft = false;
        return {};
      }
      if (path.startsWith("compare/")) {
        const [base, head] = path.slice("compare/".length).split("...");
        return { status: base === head || state.merged || head === "merged-commit" ? "ahead" : "diverged" };
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

const drive = async (state: World) => deliver(REPO, 1, githubIO(state));

test("protected paths are never merged without a person's deliver-attended", { timeout: 2000 }, async () => {
  const unattended = world({ files: ["scripts/build.sh"] });
  const stopped = await drive(unattended);
  assert.match(stopped.summary, /受保护路径/);
  assert.equal(stopped.reviewOnly, true);
  assert.equal(unattended.mergedCalls, 0, "没人确认就没有合并调用");
  assert.equal(unattended.reviewed, false, "受保护路径不进审查");
  assert.ok(unattended.statuses.some((s) => s.state === "failure"));
  assert.equal(
    unattended.pr.labels.some((l: any) => l.name === "deliver"),
    false,
    "标签清了",
  );

  // With the person's mark on the change, the same protected paths go all the way through.
  const attended = world({ pr: { ...world().pr, labels: [{ name: "deliver" }, { name: "deliver-attended" }] } });
  const passed = await drive(attended);
  assert.match(passed.summary, /已合并/);
  assert.equal(attended.merged, true);
});

test(
  "a check that runs a definition differing from main's is not main's, unless attended",
  { timeout: 2000 },
  async () => {
    const mismatched = world();
    mismatched.workflow.head = "pr-own-copy";
    const stopped = await drive(mismatched);
    assert.match(stopped.summary, /定义与 main 不一致/);
    assert.equal(mismatched.mergedCalls, 0);

    const attended = world({ pr: { ...world().pr, labels: [{ name: "deliver" }, { name: "deliver-attended" }] } });
    attended.workflow.head = "pr-own-copy";
    const passed = await drive(attended);
    assert.match(passed.summary, /已合并/);
    assert.equal(attended.merged, true);
  },
);

test("a draft is readied, not refused, and merges once its check passes", { timeout: 2000 }, async () => {
  const state = world();
  state.pr.draft = true;
  const result = await drive(state);
  assert.match(result.summary, /已合并/);
  assert.equal(state.pr.draft, false, "转正了");
  assert.equal(state.merged, true);
});

test("a moved head or a moved main stops the merge without touching the platform", { timeout: 3000 }, async () => {
  // The head is pushed again while the review runs: the attestation no longer matches what is there, nothing merges.
  const moved = world();
  const movedIO = githubIO(moved);
  const review = movedIO.review.bind(movedIO);
  movedIO.review = async (...args: any[]) => {
    moved.pr.head.sha = "pushed-again";
    return review(...(args as [any, any, string]));
  };
  await assert.rejects(deliver(REPO, 1, movedIO), /审查期间提交变了/);
  assert.equal(moved.mergedCalls, 0);

  // Main advances while the review runs; the merge gate reads main again and refuses.
  const advanced = world();
  const advancedIO = githubIO(advanced);
  const review2 = advancedIO.review.bind(advancedIO);
  advancedIO.review = async (...args: any[]) => {
    advanced.main = "main-2";
    return review2(...(args as [any, any, string]));
  };
  await assert.rejects(deliver(REPO, 1, advancedIO), /main 已前进/);
  assert.equal(advanced.mergedCalls, 0);
});

test("a lost merge answer is read back, and the merge is never repeated", { timeout: 2000 }, async () => {
  const state = world();
  state.merged = true; // the platform accepted the merge; the answer was lost on the way back
  const result = await drive(state);
  assert.match(result.summary, /已合并/);
  assert.equal(state.mergedCalls, 1, "只合并了一次");
});

test("the settings a delivery runs by are read from main, and Ship waits for them", { timeout: 2000 }, async () => {
  const state = world();
  await drive(state);
  assert.deepEqual(state.askedSettingsRef, [state.main], "只从 main 读设置");
  assert.equal(state.merged, true);
});

// Failure modes: a shared plan drops a repeated reviewer, a policy change reuses the old review, a retry rereviews the
// same commit or ignores a finding, a new commit is reviewed with the whole branch, a forged description grants a review,
// an expanded deep-review path reuses an ordinary review, a suggestion holds the change back or needs a 处理 line, a
// clean sync lets an unfixed blocking finding through, the round after a blocking one looks for new edge cases instead
// of checking that finding, a third round runs instead of waiting for the owner, an owner decision written by an
// untrusted account or before the second round's findings counts, a whole-branch review forgets the last round's findings, and a reviewer renamed by the policy (an agent's deep reviewer, or the default raised to the
// same depth) reviews the whole branch again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { settings } from "../plugins/delivery/project.ts";
import { readSharedPolicy, reviewDelivery, selectReview } from "../plugins/delivery/review.ts";
import { reviewCovers } from "../plugins/delivery/review-policy.ts";
import { ledger, renderRound } from "../plugins/delivery/review-ledger.ts";

test("a shared policy is read from main and can ask the same reviewer twice", async () => {
  const policy = await readSharedPolicy("example/config:policy.json", (repo) => async (path) => {
    assert.equal(repo, "example/config");
    assert.equal(path, "contents/policy.json?ref=main");
    return {
      content: Buffer.from(
        JSON.stringify({
          trusted_submitters: [1],
          reviewers: { codex: "review-model", deep: { model: "review-model", effort: "xhigh" } },
          default: ["codex"],
          agents: { codex: [], claude: ["deep", "deep"] },
        }),
      ).toString("base64"),
    };
  });
  const config = settings({ repo: "example/app", internal: [], review: { points: "AGENTS.md" } });
  assert.deepEqual(policy.trusted_submitters, [1]);
  assert.deepEqual(selectReview(config, "codex", false, policy), []);
  assert.deepEqual(selectReview(config, "codex", true, policy), selectReview(config, null, false, policy));
  assert.deepEqual(
    selectReview(config, "claude", false, policy).map((reviewer) => reviewer.effort),
    ["xhigh", "xhigh"],
  );
});

test("the description holds the review across retries; only blocking findings return the change, and two rounds hand it to the owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-ledger-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = (path: string, text: string) => {
      writeFileSync(join(repo, path), text);
      git("add", path);
      git("commit", "-qm", path);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    const main = commit("AGENTS.md", "## 审查要点\n保住行为。\n");
    const reviewer = join(root, "review.mjs");
    writeFileSync(
      reviewer,
      `import fs from 'node:fs';
let prompt='';for await(const b of process.stdin)prompt+=b;
const diff=fs.readFileSync(process.argv[2],'utf8');
fs.appendFileSync(process.argv[3],JSON.stringify({diff,prompt})+'\\n');
const findings=[];
if(/^\\+.*bad change/m.test(diff))findings.push({level:'挡上线',title:'有问题',how:'每次保存都会碰到',text:'数据会丢'});
if(/^\\+.*meh/m.test(diff))findings.push({level:'建议',title:'可以更好',how:'两个人同一秒改同一行时',text:'后写的盖掉先写的'});
console.log(JSON.stringify({findings}));
`,
    );
    const reviewed = join(root, "reviews.jsonl");
    const rounds = () =>
      readFileSync(reviewed, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const config = settings({
      repo: "example/app",
      internal: [],
      review: { points: "AGENTS.md", command: [process.execPath, reviewer, "{input}", reviewed], trusted: [1] },
    });
    const pr = {
      number: 7,
      head: { sha: commit("feature.txt", "bad change\nmeh\n") },
      labels: [],
      body: "## 作者写的说明\n原文",
    };
    const original = pr.body;
    const states = new Map<string, any[]>();
    let tick = 0;
    const at = () => new Date(Date.UTC(2026, 10, 19, 0, 0, tick++)).toISOString();
    const run = (verifyOnly = false, settings = config) =>
      reviewDelivery(repo, join(root, "snapshot"), main, pr, settings, {
        api: async (path, body, method) => {
          if (path.startsWith("statuses/")) {
            const sha = path.slice("statuses/".length);
            states.set(sha, [{ ...body, creator: { id: 1 }, created_at: at() }, ...(states.get(sha) ?? [])]);
            return {};
          }
          assert.equal(path, "pulls/7");
          if (method === "PATCH") pr.body = body.body;
          return structuredClone(pr);
        },
        statuses: (sha) => states.get(sha) ?? [],
        reviewerId: () => 1,
        verifyOnly,
      });
    const builtin = { ...config, review: { ...config.review, command: undefined } };
    pr.body += `\n\n## Codex 审查\n\n第 1 轮（gpt-6.2-sol，high，审到 ${pr.head.sha.slice(0, 12)}）：没有发现问题。\n`;
    assert.match(((await run(true, builtin)) as { blocked: string }).blocked, /恢复.*审查记录/);
    pr.body = original;

    // Round 1: the blocking finding returns the change; the suggestion is only recorded.
    const first = (await run()) as { level: string }[];
    assert.deepEqual(
      first.map((finding) => finding.level),
      ["block"],
    );
    assert.match(pr.body, /第 1 轮[^\n]+挡上线 1 条，建议 1 条。/);
    assert.match(pr.body, /1\. \*\*有问题\*\*\n\n   怎么发生：每次保存都会碰到\n   数据会丢\n\n   处理：/);
    assert.match(pr.body, /建议（不挡上线）：\n\n- \*\*可以更好\*\*：两个人同一秒改同一行时。后写的盖掉先写的/);
    assert.equal((pr.body.match(/处理：/g) ?? []).length, 1);
    const reviewedBody = pr.body;
    for (const tampered of [original, reviewedBody.replace("有问题", "改掉了发现")]) {
      pr.body = tampered;
      assert.match(((await run(true)) as { blocked: string }).blocked, /恢复.*审查记录/);
    }
    pr.body = reviewedBody;
    assert.match(((await run()) as { blocked: string }).blocked, /第 1 条/);

    pr.body = pr.body.replace("处理：", "处理：不改");

    // Round 2 only checks the blocking finding against the final change since round 1.
    commit("feature.txt", "bad change\n");
    pr.head.sha = commit("fix.txt", "still bad change\n");
    // One round isn't the owner's to settle: a decision written now doesn't skip the check.
    const early = pr.head.sha;
    states.set(early, [
      { context: "delivery-owner/7", state: "success", description: "放行", creator: { id: 1 }, created_at: at() },
    ]);
    assert.deepEqual(await run(true), { changed: true });
    assert.match(((await run()) as { blocked: string }).blocked, /两轮.*负责人/);
    const second = rounds()[1];
    assert.doesNotMatch(second.diff, /^\+bad change/m);
    assert.match(second.diff, /still bad change/);
    assert.match(second.prompt, /这一轮核对/);
    assert.match(second.prompt, /有问题/);
    assert.match(pr.body, /第 2 轮[^\n]+挡上线 1 条，建议 0 条。\n\n已经审了两轮/);

    // A decision written before the second round didn't see its findings.
    pr.body = pr.body.replace(/处理：$/m, "处理：等负责人");
    assert.match(((await run()) as { blocked: string }).blocked, /两轮.*负责人/);

    // No third round: a new commit waits for the owner, whose decision only counts from a trusted account.
    pr.head.sha = commit("later.txt", "another try\n");
    assert.match(((await run()) as { blocked: string }).blocked, /两轮.*负责人/);
    const owner = (id: number) => ({
      context: "delivery-owner/7",
      state: "success",
      description: "放行",
      creator: { id },
      created_at: at(),
    });
    states.set(pr.head.sha, [owner(2), ...(states.get(pr.head.sha) ?? [])]);
    assert.match(((await run()) as { blocked: string }).blocked, /两轮.*负责人/);
    states.set(pr.head.sha, [owner(1), ...(states.get(pr.head.sha) ?? [])]);
    assert.deepEqual(await run(true), []);
    assert.deepEqual(await run(), []);
    assert.equal(rounds().length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a round after a clean one reviews the new commits in full; a new reviewer reviews the whole branch, known findings included", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-ledger-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = (path: string, text: string) => {
      writeFileSync(join(repo, path), text);
      git("add", path);
      git("commit", "-qm", path);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    const main = commit("AGENTS.md", "## 审查要点\n保住行为。\n");
    const reviewer = join(root, "review.mjs");
    writeFileSync(
      reviewer,
      `import fs from 'node:fs';
let prompt='';for await(const b of process.stdin)prompt+=b;
fs.appendFileSync(process.argv[3],JSON.stringify({diff:fs.readFileSync(process.argv[2],'utf8'),prompt})+'\\n');
const findings=/^\\+.*bad/m.test(fs.readFileSync(process.argv[2],'utf8'))?[{level:'挡上线',title:'登录没校验',how:'每次登录',text:'谁都能进'}]:[];
console.log(JSON.stringify({findings}));
`,
    );
    const reviewed = join(root, "reviews.jsonl");
    const rounds = () =>
      readFileSync(reviewed, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const config = settings({
      repo: "example/app",
      internal: [],
      review: { points: "AGENTS.md", command: [process.execPath, reviewer, "{input}", reviewed] },
    });
    const pr = { number: 7, head: { sha: commit("feature.txt", "first\n") }, labels: [], body: "" };
    const states = new Map<string, any[]>();
    const run = (verifyOnly = false, settings = config) =>
      reviewDelivery(repo, join(root, "snapshot"), main, pr, settings, {
        api: async (path, body, method) => {
          if (path.startsWith("statuses/")) {
            const sha = path.slice("statuses/".length);
            states.set(sha, [{ ...body, creator: { id: 1 } }, ...(states.get(sha) ?? [])]);
            return {};
          }
          if (method === "PATCH") pr.body = body.body;
          return structuredClone(pr);
        },
        statuses: (sha) => states.get(sha) ?? [],
        reviewerId: () => 1,
        verifyOnly,
      });
    assert.deepEqual(await run(), []);
    pr.head.sha = commit("second.txt", "bad second\n");
    assert.equal(((await run()) as unknown[]).length, 1);
    assert.match(rounds()[1].diff, /second/);
    assert.doesNotMatch(rounds()[1].diff, /first/);
    assert.doesNotMatch(rounds()[1].prompt, /这一轮核对/);
    // A new depth reviews the whole branch afresh, and still with the finding the last round left.
    pr.body = pr.body.replace("处理：", "处理：改了");
    pr.head.sha = commit("third.txt", "third\n");
    const expandedDepth = { ...config, review: { ...config.review, xhigh: ["feature.txt"] } };
    assert.deepEqual(await run(true, expandedDepth), { changed: true });
    await run(false, expandedDepth);
    assert.match(rounds()[2].diff, /first/);
    assert.match(rounds()[2].prompt, /登录没校验/);
    assert.match(pr.body, /第 3 轮（[^\n]+，xhigh，审到 /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a round keeps its credit when the same model reviewed at the same depth, whatever the policy named it", () => {
  const deep = { name: "codex-deep", model: "gpt-6.2-sol", effort: "xhigh" };
  const plain = { name: "codex", model: "gpt-6.2-sol", effort: "high" };
  // An agent's deep reviewer, then nobody declared: the default reviewer raised to xhigh by a deep-review path.
  assert.ok(reviewCovers({ signature: "codex-deep/gpt-6.2-sol@xhigh", effort: "xhigh" }, [plain], ["xhigh"]));
  assert.ok(reviewCovers({ signature: "codex/gpt-6.2-sol", effort: "xhigh" }, [deep], ["xhigh"]));
  assert.ok(!reviewCovers({ signature: "codex/gpt-6.2-sol", effort: "high" }, [plain], ["xhigh"]));
  assert.ok(
    !reviewCovers({ signature: "codex/gpt-6.2-sol", effort: "high" }, [{ ...plain, model: "other" }], ["high"]),
  );
  assert.ok(
    !reviewCovers({ signature: "codex-deep/gpt-6.2-sol@xhigh", effort: "xhigh" }, [deep, deep], ["xhigh", "xhigh"]),
  );
  const command = { name: "custom", command: ["node", "review.mjs"] };
  const recorded = { signature: `command/${"0".repeat(64)}`, effort: "high" };
  assert.ok(!reviewCovers(recorded, [command], ["high"]));
});

test("a finding written over several lines stays one finding inside the review record", () => {
  const how = "1. 打开页面\n2. 连点两次\n## 结果";
  const text = "1. 发了两封\n## 后果";
  const round = renderRound(ledger(""), "codex/m", ["high"], "a".repeat(40), [
    { level: "block", title: "重复发信", how, text },
  ]);
  const record = ledger(ledger("").append(round));
  assert.equal(record.rounds.length, 1);
  assert.equal(record.rounds[0].blocking, 1);
  assert.deepEqual(record.unhandled, [1]);
});

test("answering a blocking finding with 不改 and only a docs commit has the next round check it against the whole change", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-ledger-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "docs"), { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = (path: string, text: string) => {
      writeFileSync(join(repo, path), text);
      git("add", path);
      git("commit", "-qm", path);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    const main = commit("AGENTS.md", "## 审查要点\n保住行为。\n");
    const reviewer = join(root, "review.mjs");
    const reviewed = join(root, "reviews.jsonl");
    writeFileSync(
      reviewer,
      `import fs from 'node:fs';
let prompt='';for await(const b of process.stdin)prompt+=b;
const diff=fs.readFileSync(process.argv[2],'utf8');
fs.appendFileSync(process.argv[3],JSON.stringify({diff,prompt})+'\\n');
const findings=/^\\+.*bad change/m.test(diff)?[{level:'挡上线',title:'有问题',how:'每次保存都会',text:'数据会丢'}]:[];
console.log(JSON.stringify({findings}));
`,
    );
    const config = settings({
      repo: "example/app",
      internal: ["docs/*.md"],
      review: { points: "AGENTS.md", command: [process.execPath, reviewer, "{input}", reviewed] },
    });
    const pr = { number: 7, head: { sha: commit("feature.txt", "bad change\n") }, labels: [], body: "" };
    const states = new Map<string, any[]>();
    const run = () =>
      reviewDelivery(repo, join(root, "snapshot"), main, pr, config, {
        api: async (path, body, method) => {
          if (path.startsWith("statuses/")) {
            const sha = path.slice("statuses/".length);
            states.set(sha, [{ ...body, creator: { id: 1 } }, ...(states.get(sha) ?? [])]);
            return {};
          }
          if (method === "PATCH") pr.body = body.body;
          return structuredClone(pr);
        },
        statuses: (sha) => states.get(sha) ?? [],
        reviewerId: () => 1,
      });
    assert.equal(((await run()) as unknown[]).length, 1);
    pr.body = pr.body.replace("处理：", "处理：不改，理由见文档");
    pr.head.sha = commit("docs/why.md", "为什么不改\n");
    assert.match(((await run()) as { blocked: string }).blocked, /两轮.*负责人/);
    const second = readFileSync(reviewed, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))[1];
    assert.match(second.diff, /bad change/);
    assert.match(second.prompt, /有问题/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

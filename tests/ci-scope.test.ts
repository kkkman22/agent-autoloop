// Which checks a change gets. Failure cases: a PR that edits the range script or a test gets a smaller scope; a
// protected path (workflow, script, test, package file, delivery settings) skips the full checks; a page a test reads
// (protocol, the plugin tutorial, the two READMEs, the skill, the recipes) is code, not text; a file this doesn't know
// falls through as full; a diff it can't get skips everything; a push to main keeps the PR scope. The workflow itself
// must read the range script from the base commit, not from the PR's own tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/ci-scope.sh", import.meta.url));
const workflow = fileURLToPath(new URL("../.github/workflows/check.yml", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "agent-autoloop-ci-scope-"));
after(() => rmSync(work, { recursive: true, force: true }));

/** A repository with one baseline commit, then a second commit made by `change`. */
function repo(
  name: string,
  change: (root: string, git: (...args: string[]) => string) => void,
  base?: (root: string) => void,
) {
  const root = join(work, name);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  for (const directory of [
    "docs",
    "kernel",
    "protocol",
    "sim",
    "scripts",
    "tests",
    "host",
    "plugins",
    "ops",
    ".github/workflows",
  ])
    mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "README.md"), "base\n");
  writeFileSync(join(root, "scripts/ci-scope.sh"), "keep\n");
  writeFileSync(join(root, ".github/workflows/check.yml"), "base\n");
  base?.(root);
  git("add", "-A");
  git("commit", "-qm", "base");
  const first = git("rev-parse", "HEAD");
  change(root, git);
  git("add", "-A");
  git("commit", "-qm", "change");
  return { root, first };
}

function scope(root: string, event = "pull_request", extra: Record<string, string> = {}) {
  const out = execFileSync("sh", [script], {
    cwd: root,
    env: { ...process.env, GITHUB_EVENT_NAME: event, BEFORE: "", ...extra },
  }).toString();
  return out.trim();
}

const touch = (root: string, file: string) => {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "changed\n");
};

test("text nothing reads skips the checks; pages tests read and code get normal; kernel, protocol and sim get full", () => {
  for (const [file, expected] of [
    ["docs/notes.md", "scope=docs"],
    ["CHANGELOG.md", "scope=docs"],
    [".github/pull_request_template.md", "scope=docs"],
    ["docs/protocol.md", "scope=normal"],
    ["README.md", "scope=normal"],
    ["README.en.md", "scope=normal"],
    ["host/runtime.ts", "scope=normal"],
    ["plugins/feishu/channel.ts", "scope=normal"],
    ["skills/agent-autoloop/SKILL.md", "scope=normal"],
    ["kernel/decide.ts", "scope=full"],
    ["protocol/rules.ts", "scope=full"],
    ["sim/world.ts", "scope=full"],
    ["something-unknown.txt", "scope=full"],
  ] as const) {
    const { root } = repo(`plain-${file.replaceAll("/", "-")}`, (root) => touch(root, file));
    assert.equal(scope(root), expected, file);
  }
});

test("a range script, test, workflow or package change always runs everything", () => {
  for (const file of [
    "scripts/ci-scope.sh",
    "tests/cards.test.ts",
    "tests/simulation.test.ts",
    ".github/workflows/check.yml",
    "package.json",
    "package-lock.json",
    "ops/delivery.json",
  ]) {
    const { root } = repo(`protected-${file.replaceAll("/", "-")}`, (root) => touch(root, file));
    assert.equal(scope(root), "scope=full", file);
  }
});

test("a file moved out of docs into kernel is seen as a full change", () => {
  const { root } = repo(
    "rename",
    (root, git) => {
      git("mv", "docs/old.md", "kernel/old.md");
    },
    (root) => writeFileSync(join(root, "docs/old.md"), "old\n"),
  );
  assert.equal(scope(root), "scope=full");
});

test("a push to main runs everything except what no test reads", () => {
  const host = repo("push-host", (root) => touch(root, "host/runtime.ts"));
  assert.equal(scope(host.root, "push", { BEFORE: host.first }), "scope=full");
  const page = repo("push-page", (root) => touch(root, "README.md"));
  assert.equal(scope(page.root, "push", { BEFORE: page.first }), "scope=full", "协议页上的例子也有测试");
  const docs = repo("push-docs", (root) => touch(root, "docs/notes.md"));
  assert.equal(scope(docs.root, "push", { BEFORE: docs.first }), "scope=docs");
});

test("a diff it can't get runs everything", () => {
  const { root } = repo("dispatch", (root) => touch(root, "docs/protocol.md"));
  assert.equal(scope(root, "workflow_dispatch"), "scope=full");
  const empty = join(work, "not-a-repo");
  mkdirSync(empty, { recursive: true });
  assert.equal(scope(empty), "scope=full");
});

test("the workflow decides a PR's scope with the base commit's script, not the PR's", () => {
  const text = readFileSync(workflow, "utf8");
  assert.match(text, /if \[ "\$EVENT" = "pull_request" \]/);
  assert.match(text, /git show "\$BASE_SHA:scripts\/ci-scope\.sh"/);
  assert.match(text, /EVENT: \$\{\{ github\.event_name \}\}/);
});
